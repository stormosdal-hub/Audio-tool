// Small shared helpers: math, formatting, colors, canvas DPI handling.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (l) => 20 * Math.log10(l + 1e-12);

// Left padding (px) reserved inside every timeline canvas for axis labels.
// Shared by the spectrogram, ruler and lanes so their time axes line up.
export const PAD_LEFT = 50;

// Format a frequency for display: 90 -> "90", 1500 -> "1.5k", 12000 -> "12k".
export function fmtHz(hz) {
  if (hz >= 1000) {
    const k = hz / 1000;
    return (k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return String(Math.round(hz));
}

// Distinct, readable lane colors.
export const LANE_COLORS = [
  "#4fd1c5", "#f59e0b", "#a78bfa", "#34d399",
  "#f472b6", "#60a5fa", "#fb7185", "#facc15",
  "#2dd4bf", "#c084fc",
];

let _colorIdx = 0;
export function nextColor() {
  const c = LANE_COLORS[_colorIdx % LANE_COLORS.length];
  _colorIdx++;
  return c;
}

// Magma-ish colormap for the spectrogram. t in [0,1] -> "rgb(...)".
const MAGMA = [
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129],
  [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135],
  [252, 253, 191],
];
export function magma(t) {
  t = clamp(t, 0, 1);
  const x = t * (MAGMA.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = MAGMA[i];
  const b = MAGMA[Math.min(i + 1, MAGMA.length - 1)];
  const r = (a[0] + (b[0] - a[0]) * f) | 0;
  const g = (a[1] + (b[1] - a[1]) * f) | 0;
  const bl = (a[2] + (b[2] - a[2]) * f) | 0;
  return `rgb(${r},${g},${bl})`;
}

// Resize a canvas backing store to match its CSS size * devicePixelRatio,
// and scale the 2D context so we can draw in CSS pixels. Returns {w,h} in CSS px.
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, dpr };
}

// Hide-on-empty helper.
export function uid() {
  // No Math.random in some sandboxes; use a monotonic counter + perf time.
  uid._n = (uid._n || 0) + 1;
  return "lane_" + uid._n + "_" + Math.floor(performance.now());
}
