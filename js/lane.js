// A Lane watches one pitch band [minHz, maxHz]. Each frame it sums the band's
// spectral energy, detects stroke onsets with an adaptive energy-envelope
// detector, keeps a bounded time-history, and renders a scrolling envelope +
// onset markers.
//
// Detection (per the design-research pass): convert each FFT dB bin to linear
// magnitude, accumulate POWER (amp^2) over the band, normalize by bin count so
// the rise ratio is band-width independent, then track two EMAs — a fast
// envelope (the attack) and a slow adaptive baseline (ambient/sustain). Fire
// when fast > riseRatio * baseline AND fast clears an absolute floor, with an
// ~80 ms refractory. The baseline updates ASYMMETRICALLY (much slower while
// energy is rising) so it never chases the transient and masks the hit.

import { clamp, fmtHz, spectralCentroid, PAD_LEFT } from "./util.js";

const HISTORY_SEC = 90;        // how much past audio we keep for scroll-back
const DISPLAY_DB_FLOOR = -95;  // bottom of the envelope's dB scale
const DISPLAY_DB_CEIL = -10;   // top of the envelope's dB scale

// Detector tunables.
const SLOW_A = 0.05;           // slow-baseline EMA coefficient (~0.3 s @60fps)
const ABS_FLOOR = 1e-6;        // absolute power gate so silence can't ratio-trigger
const WARMUP_FRAMES = 25;      // let the baseline settle before allowing fires

// Envelope defaults (ms). The fast envelope is now a real time-constant follower
// driven by the actual frame dt, with separate attack (rise) and release (fall)
// so it can be matched to a sound's shape. ~25 ms ≈ the old per-frame 0.5 EMA.
const DEF_ATTACK_MS = 25;
const DEF_RELEASE_MS = 25;
const DEF_REFRACTORY_MS = 80;  // debounce after a confirmed onset

export class Lane {
  constructor(cfg) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.color = cfg.color;
    this.minHz = 1;
    this.maxHz = 2;
    this.setBand(cfg.minHz, cfg.maxHz); // normalize inverted/out-of-range bands
    this.sensitivity = cfg.sensitivity ?? 55; // 0..100
    this.gainDb = cfg.gainDb ?? 0;
    this.muted = false;

    // Advanced detection settings (all default to current behavior).
    this.attackMs = cfg.attackMs ?? DEF_ATTACK_MS;
    this.releaseMs = cfg.releaseMs ?? DEF_RELEASE_MS;
    this.refractoryMs = cfg.refractoryMs ?? DEF_REFRACTORY_MS;
    // Spectral-centroid (timbre) gate, in Hz. 0 = unbounded on that side, so the
    // default 0/0 lets every onset through regardless of brightness.
    this.centroidMinHz = cfg.centroidMinHz ?? 0;
    this.centroidMaxHz = cfg.centroidMaxHz ?? 0;

    // bounded ring of { t, level(0..1), db, onset } in chronological order
    this.history = [];

    // detector state
    this.fast = 0;
    this.slow = 0;
    this.warm = 0;
    this.lastOnsetT = -1;
    this.onsetCount = 0;
    this.lastIntervalMs = 0;
    this._wasAbove = false; // edge-trigger state
    this._litUntil = -1;
    this._lastFrameT = -1;  // for real-time dt of the envelope follower
    this.liveCentroid = 0;  // brightness of the most recent frame
    this.lastCentroid = 0;  // brightness measured at the last accepted onset

    this.canvas = null;
    this.c2d = null;
  }

  attachCanvas(canvas) {
    this.canvas = canvas;
    this.c2d = canvas.getContext("2d");
  }

  setBand(minHz, maxHz) {
    this.minHz = Math.max(1, Math.min(minHz, maxHz));
    this.maxHz = Math.max(this.minHz + 1, Math.max(minHz, maxHz));
  }

  clear() {
    this.history.length = 0;
    this.fast = 0;
    this.slow = 0;
    this.warm = 0;
    this.lastOnsetT = -1;
    this.onsetCount = 0;
    this.lastIntervalMs = 0;
    this._wasAbove = false;
    this._litUntil = -1;
    this._lastFrameT = -1;
    this.liveCentroid = 0;
    this.lastCentroid = 0;
  }

  // Called once per audio frame with the shared analysis data.
  process(frame) {
    const { freqLin, binHz, nyquist } = frame;
    const nbins = freqLin.length;

    const maxHz = Math.min(this.maxHz, nyquist);
    const i0 = clamp(Math.round(this.minHz / binHz), 1, nbins - 1);
    const i1 = clamp(Math.round(maxHz / binHz), i0, nbins - 1);

    let sumMag = 0;
    let sumPow = 0;
    for (let i = i0; i <= i1; i++) {
      const a = freqLin[i];
      sumMag += a;
      sumPow += a * a;
    }
    const nb = i1 - i0 + 1;
    const energy = sumPow / nb;     // mean power, band-width independent
    const avgMag = sumMag / nb;

    // Display level: mean band magnitude in dB, mapped to 0..1.
    const db = 20 * Math.log10(avgMag + 1e-12) + this.gainDb;
    const level = clamp((db - DISPLAY_DB_FLOOR) / (DISPLAY_DB_CEIL - DISPLAY_DB_FLOOR), 0, 1);

    // Spectral centroid (brightness) of the whole frame — band-independent, so
    // we cache it on the frame to share across lanes and across replay passes.
    let centroid = frame._centroid;
    if (centroid === undefined) {
      centroid = spectralCentroid(freqLin, binHz);
      frame._centroid = centroid;
    }
    this.liveCentroid = centroid;

    // --- Onset detection (edge-triggered energy envelope) ---
    // fast = attack envelope; slow = adaptive baseline. We fire on the RISING
    // EDGE of "fast clears riseRatio × baseline", so a sustained or ringing note
    // produces ONE onset instead of re-firing every refractory period. The
    // baseline adapts asymmetrically (4× slower while rising) so it never
    // chases the transient and masks it.
    //
    // The fast envelope is a real time-constant follower driven by the actual
    // frame dt, with separate attack (rise) and release (fall) so its shape can
    // be tuned per lane to the sound it watches.
    const dt = this._lastFrameT >= 0 ? clamp(frame.t - this._lastFrameT, 1e-4, 0.1) : 1 / 60;
    this._lastFrameT = frame.t;
    const aAtk = 1 - Math.exp(-dt / Math.max(0.001, this.attackMs / 1000));
    const aRel = 1 - Math.exp(-dt / Math.max(0.001, this.releaseMs / 1000));
    const aFast = energy > this.fast ? aAtk : aRel;
    this.fast += aFast * (energy - this.fast);
    if (this.warm < WARMUP_FRAMES) {
      // Seed the baseline with a clean running mean during warm-up (only one
      // update per frame — no asymmetric EMA on top).
      this.slow = (this.slow * this.warm + energy) / (this.warm + 1);
      this.warm++;
    } else {
      const a = energy > this.slow ? SLOW_A * 0.25 : SLOW_A;
      this.slow += a * (energy - this.slow);
    }

    const sens = this.sensitivity / 100;          // 0..1
    const riseRatio = 2.6 - 1.4 * sens;           // ~2.6 (picky) .. ~1.2 (eager); default ≈1.8
    const above =
      this.fast > ABS_FLOOR && this.fast > riseRatio * Math.max(this.slow, ABS_FLOOR);

    const tms = frame.t * 1000;
    const primed = tms - this.lastOnsetT > this.refractoryMs;

    // Timbre gate: only accept the hit if the frame's brightness (centroid) sits
    // inside the configured window. 0 means "no limit" on that side.
    const passCentroid =
      (this.centroidMinHz <= 0 || centroid >= this.centroidMinHz) &&
      (this.centroidMaxHz <= 0 || centroid <= this.centroidMaxHz);

    let onset = false;
    if (!this.muted && this.warm >= WARMUP_FRAMES && above && !this._wasAbove && primed && passCentroid) {
      onset = true;
      if (this.lastOnsetT > 0) this.lastIntervalMs = tms - this.lastOnsetT;
      this.lastOnsetT = tms;
      this.onsetCount++;
      this.lastCentroid = centroid;
      this._litUntil = frame.t + 0.12;
    }
    this._wasAbove = above;

    this.history.push({ t: frame.t, level, db, onset });

    const cutoff = frame.t - HISTORY_SEC;
    let drop = 0;
    while (drop < this.history.length && this.history[drop].t < cutoff) drop++;
    if (drop > 0) this.history.splice(0, drop);
  }

  // Draw the scrolling timeline. nowT is the timestamp mapped to the right edge.
  render(nowT, pps) {
    const cv = this.canvas;
    const c = this.c2d;
    if (!cv || !c) return;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    const leftX = PAD_LEFT;

    c.clearRect(0, 0, W, H);
    c.fillStyle = "#10151c";
    c.fillRect(0, 0, W, H);

    c.strokeStyle = "rgba(255,255,255,0.05)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(leftX, H - 0.5); c.lineTo(W, H - 0.5);
    c.moveTo(leftX, H * 0.5); c.lineTo(W, H * 0.5);
    c.stroke();

    const hist = this.history;
    if (hist.length > 1) {
      const xOf = (t) => W - (nowT - t) * pps;

      // Envelope fill.
      c.beginPath();
      let started = false;
      let lastX = leftX;
      for (let k = 0; k < hist.length; k++) {
        const p = hist[k];
        const x = xOf(p.t);
        if (x < leftX) continue;
        if (x > W + 2) break;
        const y = H - p.level * (H - 2);
        if (!started) { c.moveTo(x, H); c.lineTo(x, y); started = true; }
        else c.lineTo(x, y);
        lastX = x;
      }
      if (started) {
        c.lineTo(Math.min(W, lastX), H);
        c.closePath();
        c.fillStyle = this._withAlpha(0.28);
        c.fill();

        // Envelope outline.
        c.beginPath();
        let drew = false;
        for (let k = 0; k < hist.length; k++) {
          const p = hist[k];
          const x = xOf(p.t);
          if (x < leftX) continue;
          if (x > W + 2) break;
          const y = H - p.level * (H - 2);
          if (!drew) { c.moveTo(x, y); drew = true; } else c.lineTo(x, y);
        }
        c.strokeStyle = this.color;
        c.lineWidth = 1.3;
        c.stroke();
      }

      // Onset markers (batched into one path for the strokes).
      c.strokeStyle = this.color;
      c.lineWidth = 1.5;
      c.globalAlpha = 0.9;
      c.beginPath();
      const marks = [];
      for (let k = 0; k < hist.length; k++) {
        const p = hist[k];
        if (!p.onset) continue;
        const x = xOf(p.t);
        if (x < leftX || x > W) continue;
        c.moveTo(x, 0); c.lineTo(x, H);
        marks.push(x);
      }
      c.stroke();
      c.globalAlpha = 1;
      c.fillStyle = this.color;
      for (const x of marks) {
        c.beginPath();
        c.moveTo(x - 4, 0); c.lineTo(x + 4, 0); c.lineTo(x, 7);
        c.closePath();
        c.fill();
      }
    }

    // Left axis label (band range) in the reserved gutter.
    c.fillStyle = "rgba(20,26,34,0.85)";
    c.fillRect(0, 0, leftX, H);
    c.fillStyle = this.color;
    c.font = "10px ui-monospace, monospace";
    c.textBaseline = "top";
    c.fillText(fmtHz(this.minHz), 4, 4);
    c.fillStyle = "#7b8694";
    c.textBaseline = "bottom";
    c.fillText(fmtHz(this.maxHz), 4, H - 4);

    if (nowT < this._litUntil) {
      c.fillStyle = this.color;
      c.beginPath();
      c.arc(W - 10, 10, 4, 0, Math.PI * 2);
      c.fill();
    }
  }

  _withAlpha(a) {
    const h = this.color.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, color: this.color,
      minHz: this.minHz, maxHz: this.maxHz,
      sensitivity: this.sensitivity, gainDb: this.gainDb,
      attackMs: this.attackMs, releaseMs: this.releaseMs,
      refractoryMs: this.refractoryMs,
      centroidMinHz: this.centroidMinHz, centroidMaxHz: this.centroidMaxHz,
    };
  }
}
