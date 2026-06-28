// Audition: listen back to the lanes by playing only a short windowed grain
// around each detected onset — the rise up and the decay down — band-filtered
// to each lane's pitch range, with per-lane mute/solo so you can focus on
// specific strokes before sending the hits to the scale.
//
// Why grains instead of each lane's full band-filtered audio? Lanes overlap on
// purpose (one stroke can register in several), so playing whole filtered bands
// would stack the SAME audio on top of itself — comb-filtered mush. Cutting a
// small window around every onset means each lane contributes only its own hits.
//
// Implementation: for each lane we render one sparse AudioBuffer that is silence
// everywhere except a faded window copied in from the engine's PCM ring at each
// onset. That single buffer is played once through highpass(minHz) ->
// lowpass(maxHz), so filtering cost is per-lane, not per-grain. All lanes start
// at the same instant, so they stay in sync. Everything runs on engine.ctx,
// because the onset timestamps and the PCM ring share that clock.

import { clamp } from "./util.js";

export class Audition {
  constructor(engine, getLanes) {
    this.engine = engine;
    this.getLanes = getLanes;     // () => Lane[]

    this.preMs = 25;              // include this much BEFORE each onset (attack)
    this.postMs = 220;           // ...and this much AFTER it (decay/ring)
    this.fadeMs = 8;             // raised-cosine edges so grains don't click
    this.masterGain = 0.9;

    this.playing = false;
    this.onPlayState = null;     // (on:boolean) => void

    this._sources = [];
    this._master = null;
    this._endTimer = 0;
    this._startedAt = 0;
    this._spanT = 0.0001;
  }

  get ctx() { return this.engine.ctx; }

  toJSON() {
    return { preMs: this.preMs, postMs: this.postMs, fadeMs: this.fadeMs, masterGain: this.masterGain };
  }
  fromJSON(o) {
    if (!o) return;
    if (o.preMs != null) this.preMs = o.preMs;
    if (o.postMs != null) this.postMs = o.postMs;
    if (o.fadeMs != null) this.fadeMs = o.fadeMs;
    if (o.masterGain != null) this.masterGain = o.masterGain;
  }

  // Onsets per lane, from the same source the scale uses (lane.history), kept to
  // the window the PCM ring actually still holds.
  _laneOnsets(range) {
    const out = [];
    for (const lane of this.getLanes()) {
      const ts = [];
      for (const h of lane.history) {
        if (h.onset && h.t >= range.t0 && h.t <= range.t1) ts.push(h.t);
      }
      if (ts.length) out.push({ lane, ts });
    }
    return out;
  }

  // True when there is captured audio AND at least one onset to play.
  canPlay() {
    const range = this.engine.audioRange();
    if (!range) return false;
    return this._laneOnsets(range).length > 0;
  }

  async play() {
    if (this.playing) return false;
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) {} }

    const range = this.engine.audioRange();
    if (!range) return false;
    const lanes = this._laneOnsets(range);
    if (!lanes.length) return false;

    // Solo wins: if any lane is soloed, only soloed lanes sound.
    const anySolo = lanes.some((x) => x.lane.audioSolo);
    const active = lanes.filter((x) => (anySolo ? x.lane.audioSolo : !x.lane.audioMuted));
    if (!active.length) return false;

    const sr = range.sampleRate;
    const pre = this.preMs / 1000;
    const post = this.postMs / 1000;
    const nyq = sr / 2;

    // Playback window: first grain's pre-roll to the last grain's tail, clamped
    // to what the ring still holds.
    let minT = Infinity, maxT = -Infinity;
    for (const { ts } of active) {
      minT = Math.min(minT, ts[0] - pre);
      maxT = Math.max(maxT, ts[ts.length - 1] + post);
    }
    minT = Math.max(minT, range.t0);
    maxT = Math.min(maxT, range.t1);
    const spanT = Math.max(0.05, maxT - minT);
    const spanLen = Math.ceil(spanT * sr);
    const fadeN = Math.max(1, Math.round((this.fadeMs / 1000) * sr));

    const master = ctx.createGain();
    master.gain.value = this.masterGain;
    master.connect(ctx.destination);

    const startAt = ctx.currentTime + 0.06;
    this._sources = [];

    for (const { lane, ts } of active) {
      const buf = ctx.createBuffer(1, spanLen, sr);
      const data = buf.getChannelData(0);

      const onsetN = Math.round(pre * sr); // where the stroke sits inside each grain
      for (const t of ts) {
        const gStart = t - pre;
        const slice = this.engine.getAudioSlice(gStart, t + post);
        const off = Math.round((gStart - minT) * sr);
        const n = slice.length;
        const fN = Math.min(fadeN, n >> 1 || 1);
        const peak = Math.min(Math.max(onsetN, fN), n - 1); // sample of the stroke itself
        const decayN = Math.max(1, n - peak);               // length of the slope down
        for (let i = 0; i < n; i++) {
          const di = off + i;
          if (di < 0 || di >= spanLen) continue;
          // Rise: short raised-cosine fade-in into the stroke (crisp, no click).
          // Slope down: raised-cosine decay from the stroke to silence, so the
          // grain ENDS at zero and nothing between strokes leaks through — only
          // the marked stroke's own attack + decay is audible.
          let env;
          if (i < fN) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fN);
          else if (i >= peak) env = 0.5 + 0.5 * Math.cos((Math.PI * (i - peak)) / decayN);
          else env = 1;
          data[di] += slice[i] * env; // overlap-add if windows touch
        }
      }

      const src = ctx.createBufferSource();
      src.buffer = buf;

      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = clamp(lane.minHz, 20, nyq - 1);
      hp.Q.value = 0.7;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = clamp(lane.maxHz, lane.minHz + 1, nyq - 1);
      lp.Q.value = 0.7;

      src.connect(hp); hp.connect(lp); lp.connect(master);
      src.start(startAt);
      this._sources.push(src);
    }

    this._master = master;
    this._startedAt = startAt;
    this._spanT = spanT;
    this.playing = true;
    if (this.onPlayState) this.onPlayState(true);

    const ms = (startAt - ctx.currentTime + spanT + 0.2) * 1000;
    this._endTimer = setTimeout(() => this.stop(), Math.max(50, ms));
    return true;
  }

  stop() {
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = 0; }
    for (const s of this._sources) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} }
    this._sources = [];
    if (this._master) { try { this._master.disconnect(); } catch (e) {} this._master = null; }
    if (this.playing) { this.playing = false; if (this.onPlayState) this.onPlayState(false); }
  }

  async toggle() { return this.playing ? (this.stop(), false) : this.play(); }

  get spanSec() { return this._spanT; }
  elapsed() {
    if (!this.playing || !this.ctx) return 0;
    return clamp(this.ctx.currentTime - this._startedAt, 0, this._spanT);
  }
}
