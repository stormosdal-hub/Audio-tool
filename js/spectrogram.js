// Scrolling log-frequency spectrogram. Helps you SEE which frequency bands your
// strokes occupy so you can pick lane ranges. Drag vertically to create a lane
// for the selected band.
//
// The main canvas holds the scrolling pixels (drawn in device pixels and
// self-copied left each frame, shifting only whole device pixels so there's no
// fractional-pixel blur). A transparent overlay canvas on top draws the
// frequency axis, lane-band guides and the drag selection — these never scroll.

import { clamp, magma, fmtHz, PAD_LEFT } from "./util.js";

const F_MIN = 30;
const F_MAX_CAP = 16000;
const DB_FLOOR = -100;
const DB_CEIL = -25;
const AXIS_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

// Precomputed colormap (256 steps) so the hot loop allocates no color strings.
const PALETTE = (() => {
  const p = new Array(256);
  for (let i = 0; i < 256; i++) p[i] = magma(i / 255);
  return p;
})();

export class Spectrogram {
  constructor(mainCanvas, overlayCanvas, onCreateLane) {
    this.canvas = mainCanvas;
    this.ctx = mainCanvas.getContext("2d");
    this.overlay = overlayCanvas;
    this.octx = overlayCanvas.getContext("2d");
    this.onCreateLane = onCreateLane;

    this.fMax = F_MAX_CAP;
    this.dpr = 1;
    this._binLo = null;     // device-row -> first fft bin
    this._binHi = null;     // device-row -> last fft bin
    this._binsFor = null;   // signature for cache invalidation
    this._scrollAccum = 0;
    this._lastT = -1;
    this._lanes = [];
    this._sel = null;       // { y0, y1 } in CSS px while dragging

    this._initInteraction();
  }

  setLanes(lanes) { this._lanes = lanes; }

  // CSS-px height helpers for the overlay (top = high freq).
  freqToY(freq, H) {
    const f = clamp(freq, F_MIN, this.fMax);
    const frac = Math.log(f / this.fMax) / Math.log(F_MIN / this.fMax);
    return clamp(frac, 0, 1) * H;
  }
  yToFreq(y, H) {
    const frac = clamp(y / H, 0, 1);
    return this.fMax * Math.pow(F_MIN / this.fMax, frac);
  }

  _ensureSize(nyquist) {
    this.fMax = Math.min(F_MAX_CAP, nyquist || F_MAX_CAP);
    const dpr = Math.min(2, window.devicePixelRatio || 1); // cap for fill cost
    this.dpr = dpr;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const bw = Math.max(1, Math.round(cw * dpr));
    const bh = Math.max(1, Math.round(ch * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      // Preserve the existing history across a resize (best effort: stretch the
      // old backing store into the new size) so the spectrogram doesn't blank
      // out while the lanes keep their history.
      let snap = null;
      if (this.canvas.width > 0 && this.canvas.height > 0) {
        snap = document.createElement("canvas");
        snap.width = this.canvas.width;
        snap.height = this.canvas.height;
        snap.getContext("2d").drawImage(this.canvas, 0, 0);
      }
      this.canvas.width = bw;
      this.canvas.height = bh;
      this.ctx.fillStyle = "#06090d";
      this.ctx.fillRect(0, 0, bw, bh);
      if (snap) this.ctx.drawImage(snap, 0, 0, snap.width, snap.height, 0, 0, bw, bh);
      this._binLo = null;
    }
  }

  // Per device row, the inclusive FFT bin range that maps onto that row. On a
  // log axis the bottom rows span many bins (averaged) and the top rows few.
  _rebuildBins(binHz, Hd, nbins) {
    const sig = `${binHz.toFixed(4)}|${Hd}|${this.fMax}|${nbins}`;
    if (this._binsFor === sig && this._binLo) return;
    const lo = new Int32Array(Hd);
    const hi = new Int32Array(Hd);
    for (let yd = 0; yd < Hd; yd++) {
      // row yd covers [yd-0.5, yd+0.5]; top row = high freq
      const fHi = this.fMax * Math.pow(F_MIN / this.fMax, Math.max(0, yd - 0.5) / Hd);
      const fLo = this.fMax * Math.pow(F_MIN / this.fMax, Math.min(Hd, yd + 0.5) / Hd);
      let bLo = Math.floor(fLo / binHz);
      let bHi = Math.ceil(fHi / binHz);
      bLo = clamp(bLo, 1, nbins - 1);
      bHi = clamp(bHi, bLo, nbins - 1);
      lo[yd] = bLo;
      hi[yd] = bHi;
    }
    this._binLo = lo;
    this._binHi = hi;
    this._binsFor = sig;
  }

  clear() {
    this.ctx.fillStyle = "#06090d";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this._scrollAccum = 0;
    this._lastT = -1;
  }

  // Scroll and paint the newest column(s). Called per audio frame.
  process(frame, pps) {
    this._ensureSize(frame.nyquist);
    const Wd = this.canvas.width;
    const Hd = this.canvas.height;
    const lin = frame.freqLin;
    this._rebuildBins(frame.binHz, Hd, lin.length);

    if (this._lastT < 0) { this._lastT = frame.t; return; }
    let dt = frame.t - this._lastT;
    this._lastT = frame.t;
    if (dt <= 0) return;
    if (dt > 0.25) dt = 0.25; // tab was backgrounded: cap the catch-up scroll

    // Scroll in device px; lock to lane pps (CSS px/s * dpr) so the time axis
    // matches the lanes. Only shift whole device pixels (accumulate remainder).
    this._scrollAccum += pps * this.dpr * dt;
    let cols = Math.floor(this._scrollAccum);
    if (cols < 1) return;
    if (cols >= Wd) { cols = Wd; this._scrollAccum = 0; }
    else this._scrollAccum -= cols;

    const ctx = this.ctx;
    ctx.drawImage(this.canvas, cols, 0, Wd - cols, Hd, 0, 0, Wd - cols, Hd);

    const x0 = Wd - cols;
    const binLo = this._binLo;
    const binHi = this._binHi;
    for (let yd = 0; yd < Hd; yd++) {
      let s = 0;
      const a = binLo[yd], b = binHi[yd];
      for (let bin = a; bin <= b; bin++) s += lin[bin];
      const mag = s / (b - a + 1);
      const dbv = 20 * Math.log10(mag + 1e-12);
      let t = (dbv - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      ctx.fillStyle = PALETTE[(t * 255) | 0];
      ctx.fillRect(x0, yd, cols, 1);
    }
  }

  // Draw overlay: gutter, frequency axis, lane band guides, selection.
  render() {
    const o = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const W = o.clientWidth, H = o.clientHeight;
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (o.width !== bw || o.height !== bh) { o.width = bw; o.height = bh; }
    const c = this.octx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    c.fillStyle = "rgba(6,9,13,0.78)";
    c.fillRect(0, 0, PAD_LEFT, H);

    c.font = "10px ui-monospace, monospace";
    c.textBaseline = "middle";
    for (const hz of AXIS_HZ) {
      if (hz < F_MIN || hz > this.fMax) continue;
      const y = this.freqToY(hz, H);
      c.strokeStyle = "rgba(255,255,255,0.08)";
      c.beginPath();
      c.moveTo(PAD_LEFT, y + 0.5);
      c.lineTo(W, y + 0.5);
      c.stroke();
      c.fillStyle = "#9aa6b4";
      c.fillText(fmtHz(hz), 6, y);
    }

    for (const lane of this._lanes) {
      const yTop = this.freqToY(lane.maxHz, H);
      const yBot = this.freqToY(lane.minHz, H);
      c.fillStyle = this._alpha(lane.color, 0.10);
      c.fillRect(PAD_LEFT, yTop, W - PAD_LEFT, Math.max(1, yBot - yTop));
      c.strokeStyle = this._alpha(lane.color, 0.85);
      c.setLineDash([4, 3]);
      c.beginPath();
      c.moveTo(PAD_LEFT, yTop + 0.5); c.lineTo(W, yTop + 0.5);
      c.moveTo(PAD_LEFT, yBot + 0.5); c.lineTo(W, yBot + 0.5);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = lane.color;
      c.fillText(lane.name, W - 8 - c.measureText(lane.name).width, (yTop + yBot) / 2);
    }

    if (this._sel) {
      const yA = Math.min(this._sel.y0, this._sel.y1);
      const yB = Math.max(this._sel.y0, this._sel.y1);
      c.fillStyle = "rgba(79,209,197,0.18)";
      c.fillRect(PAD_LEFT, yA, W - PAD_LEFT, yB - yA);
      c.strokeStyle = "rgba(79,209,197,0.9)";
      c.strokeRect(PAD_LEFT + 0.5, yA + 0.5, W - PAD_LEFT - 1, yB - yA - 1);
      c.fillStyle = "#cdfdf6";
      c.fillText(
        `${fmtHz(this.yToFreq(yB, H))} – ${fmtHz(this.yToFreq(yA, H))} Hz`,
        PAD_LEFT + 6, yA + 12
      );
    }
  }

  _alpha(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  _initInteraction() {
    const o = this.overlay;
    const yIn = (e) => {
      const r = o.getBoundingClientRect();
      return clamp(e.clientY - r.top, 0, r.height);
    };
    let dragging = false;
    o.addEventListener("pointerdown", (e) => {
      dragging = true;
      o.setPointerCapture(e.pointerId);
      const y = yIn(e);
      this._sel = { y0: y, y1: y };
    });
    o.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this._sel.y1 = yIn(e);
    });
    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      const H = o.clientHeight;
      const sel = this._sel;
      this._sel = null;
      if (!sel) return;
      if (Math.abs(sel.y1 - sel.y0) < 6) return;
      const f0 = this.yToFreq(Math.max(sel.y0, sel.y1), H);
      const f1 = this.yToFreq(Math.min(sel.y0, sel.y1), H);
      this.onCreateLane(Math.round(f0), Math.round(f1));
    };
    o.addEventListener("pointerup", finish);
    o.addEventListener("pointercancel", () => { dragging = false; this._sel = null; });
  }
}
