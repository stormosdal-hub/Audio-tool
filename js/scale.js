// The "Highlight Scale": a bar/beat arrangement editor. Detected hits from the
// lanes get plotted here as events on per-track timelines; each track plays a
// drum-kit sound (or a loaded sample); events can be dragged in time (with
// snap-to-grid) and played back at a chosen BPM with a moving playhead.

import { fitCanvas, clamp } from "./util.js";
import { DrumKit } from "./drumkit.js";

const ROW_H = 46;     // px height of one track row (must match the DOM rows)
const RULER_H = 28;   // px height of the bar/beat ruler at the top
const SCALE_KEY = "groove-scale-v1";

let _idCounter = 0;
const uid = (p) => `${p}_${++_idCounter}_${Math.floor(performance.now())}`;

export class Scale {
  constructor(gridCanvas, tracksContainer, kit, opts = {}) {
    this.canvas = gridCanvas;
    this.tracksEl = tracksContainer;
    this.kit = kit;
    this.onPlayState = opts.onPlayState || null;

    // musical state
    this.bpm = 100;
    this.beatsPerBar = 4;
    this.bars = 4;
    this.snap = 0.25;   // beats; 0 = off (0.25 = sixteenths, 0.5 = eighths, 1 = quarters)
    this.loop = true;

    this.tracks = [];
    this.events = [];
    this.selected = null;

    // playback
    this.playing = false;
    this._timer = 0;
    this._t0 = 0;
    this._idx = 0;
    this._loopN = 0;
    this._loopLen = 0;
    this._sorted = [];

    this._drag = null;
    this._initPointer();
    this._initKeyboard();
  }

  totalBeats() { return this.bars * this.beatsPerBar; }
  secPerBeat() { return 60 / this.bpm; }

  // ---------------- tracks ----------------
  _makeTrack(cfg = {}) {
    return {
      id: cfg.id || uid("trk"),
      laneId: cfg.laneId || null,
      name: cfg.name || "Track",
      color: cfg.color || "#4fd1c5",
      soundId: cfg.soundId || "kick",
      sampleBuffer: null,
      sampleName: cfg.sampleName || null,
      gain: cfg.gain == null ? 0.9 : cfg.gain,
      muted: !!cfg.muted,
    };
  }

  addTrack(cfg) {
    const rotate = DrumKit.SOUNDS[this.tracks.length % DrumKit.SOUNDS.length].id;
    const t = this._makeTrack({ soundId: rotate, name: `Track ${this.tracks.length + 1}`, ...cfg });
    this.tracks.push(t);
    this._rebuildTrackDom();
    this._save();
    return t;
  }

  removeTrack(id) {
    this.tracks = this.tracks.filter((t) => t.id !== id);
    this.events = this.events.filter((e) => e.trackId !== id);
    this._rebuildTrackDom();
    this._save();
  }

  _track(id) { return this.tracks.find((t) => t.id === id); }
  _trackIndex(id) { return this.tracks.findIndex((t) => t.id === id); }

  _suggestSound(name) {
    const n = (name || "").toLowerCase();
    if (/bass|tumba|sub/.test(n)) return "kick";
    if (/slap|crack/.test(n)) return "snare";
    if (/open|conga|segundo/.test(n)) return "congaHi";
    if (/quinto|high/.test(n)) return "congaHi";
    if (/hat|shak|tick|hi-?hat/.test(n)) return "hatClosed";
    if (/clave|rim/.test(n)) return "clave";
    if (/clap/.test(n)) return "clap";
    return "congaLo";
  }

  // ---------------- events ----------------
  _snap(beat) { return this.snap > 0 ? Math.round(beat / this.snap) * this.snap : beat; }

  addEvent(trackId, beat, velocity = 0.9) {
    const ev = { id: uid("ev"), trackId, beat: clamp(beat, 0, this.totalBeats()), velocity };
    this.events.push(ev);
    return ev;
  }

  removeEvent(ev) {
    this.events = this.events.filter((e) => e !== ev);
    if (this.selected === ev) this.selected = null;
  }

  clearEvents() { this.events = []; this.selected = null; this._save(); }

  // Plot the onsets detected in the lanes onto the scale (one track per lane).
  // Re-sending replaces a lane's existing events. Returns how many were added.
  fromLaneOnsets(lanes) {
    const all = [];
    for (const lane of lanes) {
      for (const h of lane.history) {
        if (h.onset) all.push({ laneId: lane.id, name: lane.name, color: lane.color, t: h.t, level: h.level });
      }
    }
    if (!all.length) return 0;

    const t0 = Math.min(...all.map((a) => a.t));
    const laneIds = [...new Set(all.map((a) => a.laneId))];
    let maxBeat = 0;
    let added = 0;

    for (const lid of laneIds) {
      const sample = all.find((a) => a.laneId === lid);
      let tr = this.tracks.find((t) => t.laneId === lid);
      if (!tr) {
        tr = this._makeTrack({
          laneId: lid, name: sample.name, color: sample.color,
          soundId: this._suggestSound(sample.name),
        });
        this.tracks.push(tr);
      }
      this.events = this.events.filter((e) => e.trackId !== tr.id);
      for (const a of all.filter((x) => x.laneId === lid)) {
        const beat = (a.t - t0) * this.bpm / 60;
        this.events.push({ id: uid("ev"), trackId: tr.id, beat, velocity: clamp((a.level || 0.5) * 1.2, 0.25, 1) });
        maxBeat = Math.max(maxBeat, beat);
        added++;
      }
    }

    const neededBars = Math.max(1, Math.ceil((maxBeat + 0.001) / this.beatsPerBar));
    if (neededBars > this.bars) this.bars = neededBars;

    this._rebuildTrackDom();
    this._save();
    return added;
  }

  // ---------------- playback ----------------
  async toggle() { if (this.playing) this.stop(); else await this.play(); }

  async play() {
    if (this.playing) return;
    await this.kit.resume();
    const ctx = this.kit.ctx;
    this._sorted = [...this.events].sort((a, b) => a.beat - b.beat);
    this._loopLen = this.totalBeats() * this.secPerBeat();
    this._t0 = ctx.currentTime + 0.08;
    this._idx = 0;
    this._loopN = 0;
    this.playing = true;
    this._tick();
    this._timer = setInterval(() => this._tick(), 25);
    if (this.onPlayState) this.onPlayState(true);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = 0;
    this.playing = false;
    if (this.onPlayState) this.onPlayState(false);
  }

  _tick() {
    if (!this.playing) return;
    const ctx = this.kit.ctx;
    const ahead = ctx.currentTime + 0.12;
    const spb = this.secPerBeat();
    let guard = 0;
    while (guard++ < 2000) {
      if (this._idx >= this._sorted.length) {
        if (this.loop && this._sorted.length > 0) { this._loopN++; this._idx = 0; }
        else break;
      }
      if (this._idx >= this._sorted.length) break;
      const ev = this._sorted[this._idx];
      const when = this._t0 + this._loopN * this._loopLen + ev.beat * spb;
      if (when < ahead) { this._fire(ev, when); this._idx++; }
      else break;
    }
    if (!this.loop && ctx.currentTime - this._t0 > this._loopLen + 0.3) this.stop();
  }

  _fire(ev, when) {
    const tr = this._track(ev.trackId);
    if (!tr || tr.muted) return;
    const g = (tr.gain == null ? 0.9 : tr.gain) * (ev.velocity == null ? 0.9 : ev.velocity);
    if (tr.sampleBuffer) this.kit.playBuffer(tr.sampleBuffer, when, { gain: g });
    else this.kit.play(tr.soundId, when, { gain: g });
  }

  preview(tr) {
    // Called from a click (user gesture) — resume first so the very first
    // preview makes sound even before Play has been pressed.
    this.kit.resume().then(() => {
      const when = this.kit.ctx.currentTime + 0.02;
      if (tr.sampleBuffer) this.kit.playBuffer(tr.sampleBuffer, when, { gain: tr.gain });
      else this.kit.play(tr.soundId, when, { gain: tr.gain });
    });
  }

  currentBeat() {
    if (!this.playing) return null;
    const ctx = this.kit.ctx;
    let el = ctx.currentTime - this._t0;
    if (el < 0) return 0;
    if (this.loop) return (el % this._loopLen) / this.secPerBeat();
    if (el > this._loopLen) return null;
    return el / this.secPerBeat();
  }

  positionLabel() {
    let b = this.currentBeat();
    if (b == null) b = 0;
    const bar = Math.floor(b / this.beatsPerBar) + 1;
    const beat = Math.floor(b % this.beatsPerBar) + 1;
    const six = Math.floor((b % 1) * 4) + 1;
    return `${bar}.${beat}.${six}`;
  }

  // ---------------- rendering ----------------
  render() {
    const cv = this.canvas;
    const { w: W, h: H } = fitCanvas(cv);
    const c = cv.getContext("2d");
    c.clearRect(0, 0, W, H);
    c.fillStyle = "#0d1219";
    c.fillRect(0, 0, W, H);

    const tb = this.totalBeats();
    const ppb = W / tb;

    // track row backgrounds
    for (let i = 0; i < this.tracks.length; i++) {
      const y = RULER_H + i * ROW_H;
      c.fillStyle = i % 2 ? "#10151d" : "#0f141b";
      c.fillRect(0, y, W, ROW_H);
    }

    // subdivision + beat + bar grid
    if (this.snap > 0 && ppb * this.snap > 4) {
      c.strokeStyle = "rgba(255,255,255,0.045)";
      c.beginPath();
      for (let b = 0; b <= tb + 1e-6; b += this.snap) { const x = b * ppb; c.moveTo(x, RULER_H); c.lineTo(x, H); }
      c.stroke();
    }
    c.strokeStyle = "rgba(255,255,255,0.10)";
    c.beginPath();
    for (let b = 0; b <= tb; b += 1) { const x = b * ppb; c.moveTo(x, RULER_H); c.lineTo(x, H); }
    c.stroke();

    c.fillStyle = "#8b97a6";
    c.font = "10px ui-monospace, monospace";
    c.strokeStyle = "rgba(255,255,255,0.30)";
    c.beginPath();
    for (let bar = 0; bar <= this.bars; bar++) {
      const x = bar * this.beatsPerBar * ppb;
      c.moveTo(x, 0); c.lineTo(x, H);
    }
    c.stroke();
    for (let bar = 0; bar < this.bars; bar++) {
      const x = bar * this.beatsPerBar * ppb;
      c.fillText(String(bar + 1), x + 4, 18);
    }

    c.strokeStyle = "rgba(255,255,255,0.15)";
    c.beginPath(); c.moveTo(0, RULER_H + 0.5); c.lineTo(W, RULER_H + 0.5); c.stroke();

    // events
    for (const ev of this.events) {
      const ti = this._trackIndex(ev.trackId);
      if (ti < 0) continue;
      const tr = this.tracks[ti];
      const x = ev.beat * ppb;
      const cy = RULER_H + ti * ROW_H + ROW_H / 2;
      const vel = clamp(ev.velocity == null ? 0.9 : ev.velocity, 0.1, 1);
      const hh = (ROW_H - 16) * vel + 8;
      const wEv = 9;
      c.fillStyle = tr.color;
      c.fillRect(x - wEv / 2, cy - hh / 2, wEv, hh);
      if (ev === this.selected) {
        c.strokeStyle = "#ffffff";
        c.lineWidth = 1.5;
        c.strokeRect(x - wEv / 2 - 1, cy - hh / 2 - 1, wEv + 2, hh + 2);
      }
    }

    // playhead
    const cb = this.currentBeat();
    if (cb != null) {
      const x = cb * ppb;
      c.strokeStyle = "#4fd1c5";
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    }
  }

  // ---------------- pointer editing ----------------
  _xToBeat(px, rectW) { return clamp((px / rectW) * this.totalBeats(), 0, this.totalBeats()); }
  _yToTrack(py) {
    const i = Math.floor((py - RULER_H) / ROW_H);
    return i >= 0 && i < this.tracks.length ? i : -1;
  }
  _hitTest(beat, ti, rectW) {
    const ppb = rectW / this.totalBeats();
    const tolBeats = 7 / ppb;
    let best = null, bestD = tolBeats;
    for (const ev of this.events) {
      if (this._trackIndex(ev.trackId) !== ti) continue;
      const d = Math.abs(ev.beat - beat);
      if (d <= bestD) { best = ev; bestD = d; }
    }
    return best;
  }

  _initPointer() {
    const cv = this.canvas;
    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
    };
    // Select an event and start dragging it from this pointer.
    const grab = (ev, beat, pointerId) => {
      this.selected = ev;
      this._drag = { ev, offset: beat - ev.beat };
      try { cv.setPointerCapture(pointerId); } catch (_) {}
      this._save();
    };
    cv.addEventListener("pointerdown", (e) => {
      const p = local(e);
      const ti = this._yToTrack(p.y);
      if (ti < 0) return;
      const beat = this._xToBeat(p.x, p.w);
      const ev = this._hitTest(beat, ti, p.w);
      if (ev) { grab(ev, beat, e.pointerId); return; } // existing hit → drag now

      // Empty spot → create a hit. On a touchscreen this requires a ~0.5 s
      // long-press, so a quick tap or a scroll gesture won't drop stray hits;
      // mouse and pen still create on click.
      if (e.pointerType === "touch") {
        this._cancelLongPress();
        const trackId = this.tracks[ti].id;
        const snapBeat = this._snap(beat);
        const pid = e.pointerId;
        this._longPress = {
          pid, x: e.clientX, y: e.clientY,
          timer: setTimeout(() => {
            this._longPress = null;
            const created = this.addEvent(trackId, snapBeat, 0.9);
            grab(created, created.beat, pid); // hold-then-drag to fine-tune
            if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
          }, 500),
        };
      } else {
        grab(this.addEvent(this.tracks[ti].id, this._snap(beat), 0.9), beat, e.pointerId);
      }
    });
    cv.addEventListener("pointermove", (e) => {
      // Movement before the timer fires means scrolling/aiming, not a press.
      if (this._longPress && e.pointerId === this._longPress.pid) {
        const dx = e.clientX - this._longPress.x, dy = e.clientY - this._longPress.y;
        if (dx * dx + dy * dy > 100) this._cancelLongPress(); // moved > 10 px
      }
      if (!this._drag) return;
      const p = local(e);
      const beat = this._xToBeat(p.x, p.w);
      this._drag.ev.beat = clamp(this._snap(beat - this._drag.offset), 0, this.totalBeats());
    });
    const end = () => {
      this._cancelLongPress();
      if (this._drag) { this._drag = null; this._save(); }
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("contextmenu", (e) => {
      e.preventDefault(); // also suppresses the mobile long-press text callout
      const p = local(e);
      const ti = this._yToTrack(p.y);
      if (ti < 0) return;
      const ev = this._hitTest(this._xToBeat(p.x, p.w), ti, p.w);
      if (ev) { this.removeEvent(ev); this._save(); }
    });
  }

  _cancelLongPress() {
    if (this._longPress) { clearTimeout(this._longPress.timer); this._longPress = null; }
  }

  _initKeyboard() {
    document.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.key === "Delete" || e.key === "Backspace") && this.selected) {
        e.preventDefault();
        this.removeEvent(this.selected);
        this._save();
      }
    });
  }

  // ---------------- track DOM ----------------
  _rebuildTrackDom() {
    const host = this.tracksEl;
    host.innerHTML = "";
    const head = document.createElement("div");
    head.className = "scale-track-head";
    head.style.height = RULER_H + "px";
    head.textContent = "tracks";
    host.appendChild(head);

    for (const tr of this.tracks) host.appendChild(this._trackRow(tr));

    // size the grid canvas to match the rows so they line up
    const h = RULER_H + Math.max(1, this.tracks.length) * ROW_H;
    this.canvas.style.height = h + "px";
  }

  _trackRow(tr) {
    const row = document.createElement("div");
    row.className = "scale-track";
    row.style.height = ROW_H + "px";

    const color = document.createElement("button");
    color.className = "st-color";
    color.style.background = tr.color;
    color.title = "Preview sound";
    color.addEventListener("click", () => this.preview(tr));

    const name = document.createElement("input");
    name.className = "st-name";
    name.value = tr.name;
    name.addEventListener("input", () => { tr.name = name.value; this._save(); });

    const sound = document.createElement("select");
    sound.className = "st-sound";
    for (const s of DrumKit.SOUNDS) {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = s.name;
      sound.appendChild(o);
    }
    sound.value = tr.soundId;
    if (tr.sampleBuffer) { const o = document.createElement("option"); o.value = "__sample__"; o.textContent = "🎵 " + (tr.sampleName || "sample"); sound.appendChild(o); sound.value = "__sample__"; }
    sound.addEventListener("change", () => {
      if (sound.value !== "__sample__") { tr.soundId = sound.value; tr.sampleBuffer = null; tr.sampleName = null; }
      this._save();
    });

    const file = document.createElement("input");
    file.type = "file"; file.accept = "audio/*"; file.style.display = "none";
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      try {
        tr.sampleBuffer = await this.kit.loadSample(f);
        tr.sampleName = f.name;
        this._rebuildTrackDom();
      } catch (err) { console.error("sample load failed", err); }
      file.value = "";
    });
    const load = document.createElement("button");
    load.className = "st-load";
    load.textContent = tr.sampleBuffer ? "🎵" : "Load";
    load.title = tr.sampleBuffer ? ("Sample: " + tr.sampleName) : "Load your own sample";
    if (tr.sampleBuffer) load.classList.add("active");
    load.addEventListener("click", () => file.click());

    const mute = document.createElement("button");
    mute.className = "st-mute";
    mute.textContent = "M";
    mute.classList.toggle("active", tr.muted);
    mute.title = "Mute track";
    mute.addEventListener("click", () => { tr.muted = !tr.muted; mute.classList.toggle("active", tr.muted); this._save(); });

    const del = document.createElement("button");
    del.className = "st-del"; del.textContent = "✕"; del.title = "Remove track";
    del.addEventListener("click", () => this.removeTrack(tr.id));

    row.append(color, name, sound, load, file, mute, del);
    return row;
  }

  // ---------------- persistence ----------------
  toJSON() {
    return {
      bpm: this.bpm, beatsPerBar: this.beatsPerBar, bars: this.bars,
      snap: this.snap, loop: this.loop,
      tracks: this.tracks.map((t) => ({
        id: t.id, laneId: t.laneId, name: t.name, color: t.color,
        soundId: t.soundId, gain: t.gain, muted: t.muted,
      })),
      events: this.events.map((e) => ({ id: e.id, trackId: e.trackId, beat: e.beat, velocity: e.velocity })),
    };
  }

  _save() {
    try { localStorage.setItem(SCALE_KEY, JSON.stringify(this.toJSON())); } catch (e) {}
  }

  load() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(SCALE_KEY)); } catch (e) {}
    if (d) {
      this.bpm = d.bpm || this.bpm;
      this.beatsPerBar = d.beatsPerBar || this.beatsPerBar;
      this.bars = d.bars || this.bars;
      this.snap = d.snap == null ? this.snap : d.snap;
      this.loop = d.loop == null ? this.loop : d.loop;
      this.tracks = (d.tracks || []).map((t) => this._makeTrack(t));
      this.events = (d.events || []).map((e) => ({ id: e.id || uid("ev"), trackId: e.trackId, beat: e.beat, velocity: e.velocity }));
    }
    this._rebuildTrackDom();
  }
}
