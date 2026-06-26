// DrumKit: a small synthesized percussion kit (no external assets, works fully
// offline) plus support for user-loaded samples. It owns its own AudioContext
// for OUTPUT (separate from the mic-capture context) and exposes scheduling-
// friendly play methods that fire a sound at an absolute context time.

export class DrumKit {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._noise = null;
  }

  // Built-in synthesized voices. id -> display name.
  static SOUNDS = [
    { id: "kick", name: "Kick" },
    { id: "snare", name: "Snare" },
    { id: "hatClosed", name: "Hat (closed)" },
    { id: "hatOpen", name: "Hat (open)" },
    { id: "clap", name: "Clap" },
    { id: "rim", name: "Rimshot" },
    { id: "tomLo", name: "Tom (low)" },
    { id: "tomHi", name: "Tom (high)" },
    { id: "congaLo", name: "Conga (low)" },
    { id: "congaHi", name: "Conga (high)" },
    { id: "clave", name: "Clave" },
    { id: "cowbell", name: "Cowbell" },
    { id: "shaker", name: "Shaker" },
  ];

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      this._noise = this._makeNoise();
    }
    return this.ctx;
  }

  async resume() {
    this.ensure();
    if (this.ctx.state !== "running") await this.ctx.resume();
    return this.ctx;
  }

  get currentTime() { return this.ctx ? this.ctx.currentTime : 0; }

  _makeNoise() {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 1.0);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _noiseSrc(when, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise;
    s.start(when);
    s.stop(when + dur + 0.05);
    return s;
  }

  // Fire a built-in voice at absolute time `when` (ctx seconds).
  play(id, when, opts = {}) {
    this.ensure();
    const g = opts.gain == null ? 1 : opts.gain;
    when = Math.max(when, this.ctx.currentTime);
    switch (id) {
      case "kick": return this._kick(when, g);
      case "snare": return this._snare(when, g);
      case "hatClosed": return this._hat(when, g, 0.05);
      case "hatOpen": return this._hat(when, g, 0.32);
      case "clap": return this._clap(when, g);
      case "rim": return this._rim(when, g);
      case "tomLo": return this._tom(when, g, 110);
      case "tomHi": return this._tom(when, g, 200);
      case "congaLo": return this._conga(when, g, 180);
      case "congaHi": return this._conga(when, g, 320);
      case "clave": return this._clave(when, g);
      case "cowbell": return this._cowbell(when, g);
      case "shaker": return this._shaker(when, g);
      default: return this._kick(when, g);
    }
  }

  // Fire a user-loaded sample buffer at absolute time `when`.
  playBuffer(buffer, when, opts = {}) {
    this.ensure();
    const g = opts.gain == null ? 1 : opts.gain;
    when = Math.max(when, this.ctx.currentTime);
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    const e = this.ctx.createGain();
    e.gain.value = g;
    s.connect(e).connect(this.master);
    s.start(when);
    return s;
  }

  // Decode a File/Blob into an AudioBuffer for use as a track sound.
  async loadSample(file) {
    this.ensure();
    const arr = await file.arrayBuffer();
    return await this.ctx.decodeAudioData(arr);
  }

  // ---- voices ----
  _gainEnv(when, peak, decay, attack = 0.001) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    return g;
  }

  _kick(when, g) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(150, when);
    o.frequency.exponentialRampToValueAtTime(50, when + 0.12);
    const e = this._gainEnv(when, g, 0.4);
    o.connect(e).connect(this.master);
    o.start(when); o.stop(when + 0.45);
  }

  _snare(when, g) {
    const ctx = this.ctx;
    const n = this._noiseSrc(when, 0.2);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 1200;
    const ne = this._gainEnv(when, g * 0.8, 0.2);
    n.connect(hp).connect(ne).connect(this.master);
    const o = ctx.createOscillator();
    o.type = "triangle"; o.frequency.setValueAtTime(180, when);
    const oe = this._gainEnv(when, g * 0.5, 0.12);
    o.connect(oe).connect(this.master);
    o.start(when); o.stop(when + 0.14);
  }

  _hat(when, g, dur) {
    const ctx = this.ctx;
    const n = this._noiseSrc(when, dur);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 7000;
    const e = this._gainEnv(when, g * 0.5, dur);
    n.connect(hp).connect(e).connect(this.master);
  }

  _clap(when, g) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 1.2;
    const e = this._gainEnv(when, g * 0.7, 0.18);
    bp.connect(e).connect(this.master);
    for (const off of [0, 0.012, 0.024, 0.036]) {
      const n = this._noiseSrc(when + off, 0.05);
      n.connect(bp);
    }
  }

  _rim(when, g) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "triangle"; o.frequency.value = 1700;
    const e = this._gainEnv(when, g * 0.6, 0.05);
    o.connect(e).connect(this.master);
    o.start(when); o.stop(when + 0.07);
  }

  _tom(when, g, f) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f, when);
    o.frequency.exponentialRampToValueAtTime(f * 0.5, when + 0.2);
    const e = this._gainEnv(when, g, 0.3);
    o.connect(e).connect(this.master);
    o.start(when); o.stop(when + 0.33);
  }

  _conga(when, g, f) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(f, when);
    o.frequency.exponentialRampToValueAtTime(f * 0.85, when + 0.12);
    const e = this._gainEnv(when, g, 0.18);
    o.connect(e).connect(this.master);
    o.start(when); o.stop(when + 0.2);
  }

  _clave(when, g) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine"; o.frequency.value = 2500;
    const e = this._gainEnv(when, g * 0.7, 0.05);
    o.connect(e).connect(this.master);
    o.start(when); o.stop(when + 0.07);
  }

  _cowbell(when, g) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 2640; bp.Q.value = 1.5;
    const e = this._gainEnv(when, g * 0.5, 0.4);
    bp.connect(e).connect(this.master);
    for (const f of [540, 800]) {
      const o = ctx.createOscillator();
      o.type = "square"; o.frequency.value = f;
      o.connect(bp);
      o.start(when); o.stop(when + 0.42);
    }
  }

  _shaker(when, g) {
    const ctx = this.ctx;
    const n = this._noiseSrc(when, 0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 6000;
    const e = this._gainEnv(when, g * 0.4, 0.06, 0.006);
    n.connect(hp).connect(e).connect(this.master);
  }
}
