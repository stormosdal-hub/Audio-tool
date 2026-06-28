// App controller: device UI, lanes, the shared render loop, and persistence.

import { AudioEngine } from "./audio-engine.js";
import { Lane } from "./lane.js";
import { Spectrogram } from "./spectrogram.js";
import { PRESETS, STARTER_LANES } from "./presets.js";
import { DrumKit } from "./drumkit.js";
import { Scale } from "./scale.js";
import { Audition } from "./audition.js";
import { openModal, initModal } from "./modal.js";
import { fitCanvas, fmtHz, nextColor, uid, PAD_LEFT, clamp } from "./util.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "conga-grapher-v1";

// On a phone-sized screen the per-lane settings and the Highlight Scale open as
// pop-up windows instead of inline panels. Evaluated at click time so it tracks
// rotation / resize. Keep the breakpoint in sync with css/mobile.css.
const isMobile = () => window.matchMedia("(max-width: 560px)").matches;

const engine = new AudioEngine();

const state = {
  lanes: [],
  pps: 140,
  frozen: false,
  freezeT: 0,
  running: false,
  lastFrameT: 0,
  deviceId: null,
  fftSize: 4096,
};

let spectro = null;
let kit = null;
let scale = null;
let audition = null;

// ------------------------------------------------------------------ helpers
function currentNow() {
  if (state.frozen) return state.freezeT;
  if (engine.ctx) return state.running ? engine.ctx.currentTime : state.lastFrameT;
  return 0;
}

function updateFreezeBtn() {
  const btn = $("freezeBtn");
  btn.classList.toggle("active", state.frozen);
  btn.textContent = state.frozen ? "▶ Resume" : "⏸ Freeze";
}

function clearFreeze() {
  state.frozen = false;
  if (spectro) spectro._lastT = -1;
  updateFreezeBtn();
}

function setRecUI(on) {
  const btn = $("recBtn");
  btn.classList.toggle("recording", on);
  btn.textContent = on ? "■ Stop rec" : "● Rec";
  $("statusDot").className = on ? "dot rec" : (state.running ? "dot live" : "dot");
}

function save() {
  const data = {
    lanes: state.lanes.map((l) => l.toJSON()),
    pps: state.pps,
    deviceId: state.deviceId,
    fftSize: state.fftSize,
    audition: audition ? audition.toJSON() : undefined,
  };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {}
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; }
}

// ------------------------------------------------------------------ lanes
function addLane(cfg) {
  const lane = new Lane({
    id: cfg.id || uid(),
    name: cfg.name || "Lane",
    color: cfg.color || nextColor(),
    minHz: cfg.minHz,
    maxHz: cfg.maxHz,
    sensitivity: cfg.sensitivity,
    gainDb: cfg.gainDb,
    attackMs: cfg.attackMs,
    releaseMs: cfg.releaseMs,
    refractoryMs: cfg.refractoryMs,
    centroidMinHz: cfg.centroidMinHz,
    centroidMaxHz: cfg.centroidMaxHz,
  });
  buildLaneDom(lane);
  engine.replayHistory(lane);
  state.lanes.push(lane);
  spectro.setLanes(state.lanes);
  updateEmptyHint();
  save();
  return lane;
}

// Re-derive a lane's whole timeline from the engine's stored raw spectra. Call
// this after any change to detection params (band, envelope, centroid gate) so
// the envelope and onset markers reflect the new settings immediately, without
// re-recording.
function recomputeLane(lane) {
  lane.clear();
  engine.replayHistory(lane);
}

function removeLane(lane) {
  const i = state.lanes.indexOf(lane);
  if (i >= 0) state.lanes.splice(i, 1);
  lane._dom?.remove();
  spectro.setLanes(state.lanes);
  updateEmptyHint();
  save();
}

function buildLaneDom(lane) {
  const el = document.createElement("div");
  el.className = "lane";
  el.innerHTML = `
    <div class="lane-head">
      <input class="lane-color" type="color" value="${lane.color}" title="Lane color" />
      <input class="lane-name" type="text" value="${escapeAttr(lane.name)}" />
      <div class="lane-freqs">
        <input class="lane-min" type="number" min="20" max="20000" step="1" value="${Math.round(lane.minHz)}" />
        <span>–</span>
        <input class="lane-max" type="number" min="20" max="20000" step="1" value="${Math.round(lane.maxHz)}" />
        <span>Hz</span>
      </div>
      <label class="lane-knob" title="Detection sensitivity">
        sens <input class="lane-sens" type="range" min="0" max="100" step="1" value="${lane.sensitivity}" />
      </label>
      <label class="lane-knob" title="Display gain (dB)">
        gain <input class="lane-gain" type="range" min="-24" max="24" step="1" value="${lane.gainDb}" />
      </label>
      <div class="lane-stats">
        <span>hits <b class="lane-count">0</b></span>
        <span><b class="lane-bpm">–</b> bpm</span>
        <button class="lane-btn lane-solo ghost" title="Solo i avspilling (lytt kun til denne)">S</button>
        <button class="lane-btn lane-amute ghost" title="Mute lyd i avspilling">🔊</button>
        <button class="lane-btn lane-settings ghost" title="Advanced detection settings">⚙</button>
        <button class="lane-btn lane-mute ghost" title="Mute detection">Mute</button>
        <button class="lane-btn lane-remove ghost" title="Remove lane">✕</button>
      </div>
    </div>
    <div class="lane-adv hidden">
      <div class="adv-group">
        <span class="adv-title">Klangfilter · Spectral Centroid</span>
        <label>min <input class="lane-cmin" type="number" min="0" max="20000" step="10" value="${Math.round(lane.centroidMinHz)}" /> Hz</label>
        <label>max <input class="lane-cmax" type="number" min="0" max="20000" step="10" value="${Math.round(lane.centroidMaxHz)}" /> Hz</label>
        <span class="adv-read">nå <b class="lane-cnow">–</b> · siste slag <b class="lane-clast">–</b></span>
      </div>
      <div class="adv-group">
        <span class="adv-title">Envelope</span>
        <label>attack <input class="lane-atk" type="range" min="1" max="200" step="1" value="${lane.attackMs}" /><b class="lane-atk-v">${lane.attackMs} ms</b></label>
        <label>release <input class="lane-rel" type="range" min="1" max="500" step="1" value="${lane.releaseMs}" /><b class="lane-rel-v">${lane.releaseMs} ms</b></label>
        <label>refractory <input class="lane-ref" type="range" min="20" max="500" step="5" value="${lane.refractoryMs}" /><b class="lane-ref-v">${lane.refractoryMs} ms</b></label>
      </div>
      <p class="adv-hint">Skarpe lyder (hi-hat, klave) har høy centroid (&gt;2 kHz) og kort attack/refractory. Dype congas har lav centroid (&lt;600 Hz) — sett <b>max</b> ned for å luke bort skarpe slag, og lengre release/refractory for boomy ettersving. 0 = ingen grense.</p>
    </div>
    <canvas class="lane-canvas"></canvas>
  `;
  lane._dom = el;
  lane._countEl = el.querySelector(".lane-count");
  lane._bpmEl = el.querySelector(".lane-bpm");
  lane._cnowEl = el.querySelector(".lane-cnow");
  lane._clastEl = el.querySelector(".lane-clast");
  lane.attachCanvas(el.querySelector(".lane-canvas"));

  const colorEl = el.querySelector(".lane-color");
  const nameEl = el.querySelector(".lane-name");
  const minEl = el.querySelector(".lane-min");
  const maxEl = el.querySelector(".lane-max");
  const sensEl = el.querySelector(".lane-sens");
  const gainEl = el.querySelector(".lane-gain");
  const muteBtn = el.querySelector(".lane-mute");

  colorEl.addEventListener("input", () => { lane.color = colorEl.value; save(); });
  nameEl.addEventListener("input", () => { lane.name = nameEl.value; save(); });
  const applyBand = () => {
    const lo = clamp(parseFloat(minEl.value) || 20, 20, 20000);
    const hi = clamp(parseFloat(maxEl.value) || 20, 20, 20000);
    lane.setBand(lo, hi);
    minEl.value = Math.round(lane.minHz);
    maxEl.value = Math.round(lane.maxHz);
    // Re-derive the whole timeline from the stored raw spectra so the envelope
    // and onset markers reflect the NEW band immediately — you can sweep the
    // frequency and watch which strokes light up without re-recording.
    recomputeLane(lane);
    save();
  };
  minEl.addEventListener("change", applyBand);
  maxEl.addEventListener("change", applyBand);
  sensEl.addEventListener("input", () => { lane.sensitivity = +sensEl.value; save(); });
  gainEl.addEventListener("input", () => { lane.gainDb = +gainEl.value; save(); });
  muteBtn.addEventListener("click", () => {
    lane.muted = !lane.muted;
    muteBtn.classList.toggle("active", lane.muted);
    muteBtn.textContent = lane.muted ? "Muted" : "Mute";
  });

  // Audition mute/solo (playback only — independent of the detection Mute above).
  const soloBtn = el.querySelector(".lane-solo");
  const aMuteBtn = el.querySelector(".lane-amute");
  soloBtn.classList.toggle("active", lane.audioSolo);
  aMuteBtn.classList.toggle("active", lane.audioMuted);
  aMuteBtn.textContent = lane.audioMuted ? "🔇" : "🔊";
  soloBtn.addEventListener("click", () => {
    lane.audioSolo = !lane.audioSolo;
    soloBtn.classList.toggle("active", lane.audioSolo);
    save();
  });
  aMuteBtn.addEventListener("click", () => {
    lane.audioMuted = !lane.audioMuted;
    aMuteBtn.classList.toggle("active", lane.audioMuted);
    aMuteBtn.textContent = lane.audioMuted ? "🔇" : "🔊";
    save();
  });

  el.querySelector(".lane-remove").addEventListener("click", () => removeLane(lane));

  // ---- Advanced detection panel ----
  const advEl = el.querySelector(".lane-adv");
  const settingsBtn = el.querySelector(".lane-settings");
  settingsBtn.addEventListener("click", () => {
    if (isMobile()) {
      // Pop the settings out into their own window. The panel is the same node,
      // so all the sliders below stay wired; it returns inline when closed.
      advEl.classList.remove("hidden");
      settingsBtn.classList.add("active");
      openModal(advEl, `${lane.name} · innstillinger`, () => {
        advEl.classList.add("hidden");
        settingsBtn.classList.remove("active");
      });
    } else {
      const nowHidden = advEl.classList.toggle("hidden");
      settingsBtn.classList.toggle("active", !nowHidden);
    }
  });

  // Centroid gate (number inputs commit on change → recompute once).
  const cminEl = el.querySelector(".lane-cmin");
  const cmaxEl = el.querySelector(".lane-cmax");
  const applyCentroid = () => {
    lane.centroidMinHz = clamp(parseFloat(cminEl.value) || 0, 0, 20000);
    lane.centroidMaxHz = clamp(parseFloat(cmaxEl.value) || 0, 0, 20000);
    cminEl.value = Math.round(lane.centroidMinHz);
    cmaxEl.value = Math.round(lane.centroidMaxHz);
    recomputeLane(lane);
    save();
  };
  cminEl.addEventListener("change", applyCentroid);
  cmaxEl.addEventListener("change", applyCentroid);

  // Envelope sliders: update the live param + label on every input (so live
  // detection responds instantly), but only replay history on release (change),
  // since replaying ~90 s of frames each input tick would be wasteful.
  const wireKnob = (input, label, unit, set) => {
    input.addEventListener("input", () => {
      const v = +input.value;
      set(v);
      label.textContent = v + unit;
    });
    input.addEventListener("change", () => { recomputeLane(lane); save(); });
  };
  wireKnob(el.querySelector(".lane-atk"), el.querySelector(".lane-atk-v"), " ms", (v) => (lane.attackMs = v));
  wireKnob(el.querySelector(".lane-rel"), el.querySelector(".lane-rel-v"), " ms", (v) => (lane.releaseMs = v));
  wireKnob(el.querySelector(".lane-ref"), el.querySelector(".lane-ref-v"), " ms", (v) => (lane.refractoryMs = v));

  $("lanes").appendChild(el);
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function updateEmptyHint() {
  $("emptyHint").classList.toggle("hidden", state.lanes.length > 0);
}

// ------------------------------------------------------------------ rendering
let statTick = 0;
function renderLoop() {
  const nowT = currentNow();
  const pps = state.pps;

  // lanes
  for (const lane of state.lanes) {
    fitCanvas(lane.canvas);
    lane.render(nowT, pps);
  }
  // ruler
  renderRuler(nowT, pps);
  // spectrogram overlay (axis/guides/selection)
  spectro.render();
  // highlight scale (grid, events, playhead)
  if (scale) scale.render();

  // throttled DOM stats
  if (++statTick % 8 === 0) {
    for (const lane of state.lanes) {
      if (lane._countEl) lane._countEl.textContent = lane.onsetCount;
      if (lane._bpmEl) {
        const bpm = lane.lastIntervalMs > 0 ? Math.round(60000 / lane.lastIntervalMs) : 0;
        lane._bpmEl.textContent = bpm > 0 && bpm < 600 ? bpm : "–";
      }
      if (lane._cnowEl) lane._cnowEl.textContent = lane.liveCentroid > 0 ? fmtHz(lane.liveCentroid) : "–";
      if (lane._clastEl) lane._clastEl.textContent = lane.lastCentroid > 0 ? fmtHz(lane.lastCentroid) : "–";
    }
    if (scale) {
      $("scalePos").textContent = scale.positionLabel();
      $("scaleEmpty").classList.toggle("hidden", scale.tracks.length > 0);
    }
    if (audition) {
      const btn = $("auditionBtn");
      if (audition.playing) {
        $("auditionPos").textContent = `${audition.elapsed().toFixed(1)} / ${audition.spanSec.toFixed(1)} s`;
      } else {
        btn.disabled = !audition.canPlay();
        $("auditionPos").textContent = "";
      }
    }
  }
  requestAnimationFrame(renderLoop);
}

function renderRuler(nowT, pps) {
  const cv = $("ruler");
  const { w: W, h: H } = fitCanvas(cv);
  const c = cv.getContext("2d");
  c.clearRect(0, 0, W, H);
  c.fillStyle = "#12181f";
  c.fillRect(0, 0, W, H);

  const span = (W - PAD_LEFT) / pps; // seconds visible
  const start = Math.ceil(nowT - span);
  c.textBaseline = "bottom";
  c.font = "10px ui-monospace, monospace";
  for (let s = start; s <= Math.floor(nowT); s++) {
    if (s < 0) continue;
    const x = W - (nowT - s) * pps;
    if (x < PAD_LEFT) continue;
    const major = s % 5 === 0;
    c.strokeStyle = major ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.10)";
    c.beginPath();
    c.moveTo(x + 0.5, major ? 4 : 10);
    c.lineTo(x + 0.5, H);
    c.stroke();
    if (major) {
      c.fillStyle = "#9aa6b4";
      c.fillText(formatTime(s), x + 3, H - 2);
    }
  }
  // gutter
  c.fillStyle = "#12181f";
  c.fillRect(0, 0, PAD_LEFT, H);
  c.fillStyle = "#6f7b8a";
  c.fillText("time", 6, H - 2);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

// ------------------------------------------------------------------ devices
async function refreshDevices() {
  const sel = $("device");
  const prev = state.deviceId || sel.value;
  const devices = await engine.listDevices();
  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "System default input";
  sel.appendChild(def);
  devices.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone ${i + 1}`;
    sel.appendChild(o);
  });
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ------------------------------------------------------------------ transport
async function start() {
  try {
    clearFreeze(); // never start up in a stale frozen state
    setStatus("requesting mic…");
    state.deviceId = $("device").value || null;
    await engine.start(state.deviceId);
    state.running = true;
    try { await refreshDevices(); } catch (e) { /* labels are a nice-to-have */ }
    $("device").value = engine.deviceId || state.deviceId || "";
    $("startBtn").textContent = "■ Stop";
    $("startBtn").classList.remove("primary");
    $("startBtn").classList.add("ghost");
    $("recBtn").disabled = false;
    $("statusDot").className = "dot live";
    setStatus("listening");
    $("sampleRate").textContent = `· ${(engine.sampleRate / 1000).toFixed(1)} kHz`;
    save();
  } catch (e) {
    console.error(e);
    engine.stop(); // keep engine state and the UI in agreement on failure
    state.running = false;
    setStatus("mic error: " + (e.name || e.message));
  }
}

function stop() {
  if (audition) audition.stop();
  engine.stop();
  state.running = false;
  $("startBtn").textContent = "▶ Start";
  $("startBtn").classList.add("primary");
  $("startBtn").classList.remove("ghost");
  $("recBtn").disabled = true;
  $("recBtn").classList.remove("recording");
  $("recBtn").textContent = "● Rec";
  $("statusDot").className = "dot";
  clearFreeze(); // don't leave the app frozen for the next Start
  setStatus("stopped");
}

function setStatus(s) { $("status").textContent = s; }

// ------------------------------------------------------------------ init
function init() {
  spectro = new Spectrogram($("spectro"), $("spectroOverlay"), (lo, hi) => {
    addLane({ name: `${fmtHz(lo)}–${fmtHz(hi)}`, minHz: lo, maxHz: hi });
  });

  // presets bar
  const pbar = $("presets");
  PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.innerHTML = `<span class="swatch" style="background:${p.color}"></span>${p.name}`;
    b.title = `Add ${p.name} lane (${fmtHz(p.minHz)}–${fmtHz(p.maxHz)} Hz)` +
      (p.note ? `\n${p.note}` : "");
    b.addEventListener("click", () =>
      addLane({ name: p.name, color: p.color, minHz: p.minHz, maxHz: p.maxHz })
    );
    pbar.appendChild(b);
  });

  // restore saved state or seed starter lanes
  const saved = load();
  if (saved) {
    state.pps = saved.pps || state.pps;
    state.fftSize = saved.fftSize || state.fftSize;
    state.deviceId = saved.deviceId || null;
    engine.setFftSize(state.fftSize);
    $("fft").value = String(state.fftSize);
    $("pps").value = String(state.pps);
    $("ppsVal").textContent = state.pps + " px/s";
    (saved.lanes || []).forEach((l) => addLane(l));
  }
  if (state.lanes.length === 0) {
    STARTER_LANES.forEach((n) => {
      const p = PRESETS.find((x) => x.name === n);
      if (p) addLane({ name: p.name, color: p.color, minHz: p.minHz, maxHz: p.maxHz });
    });
  }
  updateEmptyHint();

  // controls
  $("startBtn").addEventListener("click", () => (state.running ? stop() : start()));
  $("refreshDevices").addEventListener("click", refreshDevices);
  $("device").addEventListener("change", async () => {
    state.deviceId = $("device").value || null;
    save();
    if (state.running) {
      // Stopping the old stream's tracks would auto-stop an in-progress
      // recording; flush it to disk first and reset the rec UI.
      if (engine.isRecording()) { engine.stopRecording(); setRecUI(false); }
      setStatus("switching device…");
      try {
        await engine.switchDevice(state.deviceId);
        // Reflect the device actually opened (may differ after a fallback).
        state.deviceId = engine.deviceId;
        $("device").value = engine.deviceId || "";
        save();
        setStatus("listening");
      } catch (e) { setStatus("device error"); }
    }
  });
  $("addLane").addEventListener("click", () =>
    addLane({ name: "New lane", minHz: 150, maxHz: 400 })
  );
  $("pps").addEventListener("input", (e) => {
    state.pps = +e.target.value;
    $("ppsVal").textContent = state.pps + " px/s";
    save();
  });
  $("fft").addEventListener("change", (e) => {
    state.fftSize = +e.target.value;
    engine.setFftSize(state.fftSize);
    save();
  });
  $("freezeBtn").addEventListener("click", () => {
    if (!state.frozen) {
      state.freezeT = currentNow(); // capture live time BEFORE flipping the flag
      state.frozen = true;
    } else {
      state.frozen = false;
      spectro._lastT = -1; // avoid a huge scroll jump on resume
    }
    updateFreezeBtn();
  });
  $("clearBtn").addEventListener("click", () => {
    if (audition) audition.stop();
    state.lanes.forEach((l) => l.clear());
    spectro.clear();
    engine.clearAudio(); // keep the audition window in step with the cleared onsets
  });
  $("recBtn").addEventListener("click", () => {
    if (engine.isRecording()) { engine.stopRecording(); setRecUI(false); }
    else if (engine.startRecording()) setRecUI(true);
  });

  // audio frames -> analysis
  engine.onFrame((frame) => {
    if (state.frozen) { spectro._lastT = frame.t; return; }
    state.lastFrameT = frame.t;
    for (const lane of state.lanes) lane.process(frame);
    spectro.process(frame, state.pps);
  });

  // ---- Highlight Scale ----
  kit = new DrumKit();
  scale = new Scale($("scaleGrid"), $("scaleTracks"), kit, {
    onPlayState: (on) => {
      const b = $("scalePlay");
      b.textContent = on ? "■ Stop" : "▶ Play";
      b.classList.toggle("primary", !on);
      b.classList.toggle("ghost", on);
    },
  });
  scale.load();
  $("bpm").value = scale.bpm;
  $("beatsPerBar").value = scale.beatsPerBar;
  $("bars").value = scale.bars;
  $("snap").value = String(scale.snap);
  $("loopBtn").classList.toggle("active", scale.loop);

  $("scalePlay").addEventListener("click", () => scale.toggle());
  $("loopBtn").addEventListener("click", () => {
    scale.loop = !scale.loop;
    $("loopBtn").classList.toggle("active", scale.loop);
    scale._save();
  });
  $("bpm").addEventListener("change", () => {
    scale.bpm = clamp(parseInt($("bpm").value, 10) || 100, 30, 300);
    $("bpm").value = scale.bpm;
    if (scale.playing) scale.stop(); // tempo change restarts cleanly
    scale._save();
  });
  $("beatsPerBar").addEventListener("change", () => {
    scale.beatsPerBar = clamp(parseInt($("beatsPerBar").value, 10) || 4, 1, 16);
    $("beatsPerBar").value = scale.beatsPerBar;
    if (scale.playing) scale.stop();
    scale._save();
  });
  $("bars").addEventListener("change", () => {
    scale.bars = clamp(parseInt($("bars").value, 10) || 4, 1, 64);
    $("bars").value = scale.bars;
    scale._save();
  });
  $("snap").addEventListener("change", () => { scale.snap = parseFloat($("snap").value); scale._save(); });
  $("sendHits").addEventListener("click", () => {
    const n = scale.fromLaneOnsets(state.lanes);
    setStatus(n > 0 ? `plotted ${n} hits to scale` : "no hits yet — record some first");
  });
  $("addTrack").addEventListener("click", () => scale.addTrack());
  $("clearScale").addEventListener("click", () => scale.clearEvents());

  // On mobile the whole Highlight Scale opens as its own pop-up window (it's
  // hidden inline via css/mobile.css). The render loop keeps drawing it; the
  // grid canvas re-fits to the modal width on the next frame.
  initModal();
  $("scaleLauncher").addEventListener("click", () => {
    openModal(document.querySelector(".scale-panel"), "Highlight Scale");
  });

  // ---- Lane audition (play windowed grains around each onset) ----
  audition = new Audition(engine, () => state.lanes);
  if (saved && saved.audition) audition.fromJSON(saved.audition);
  $("auPre").value = audition.preMs;
  $("auPost").value = audition.postMs;
  $("auFade").value = audition.fadeMs;
  $("auVol").value = Math.round(audition.masterGain * 100);
  $("auPreV").textContent = audition.preMs + " ms";
  $("auPostV").textContent = audition.postMs + " ms";
  $("auFadeV").textContent = audition.fadeMs + " ms";
  audition.onPlayState = (on) => {
    const b = $("auditionBtn");
    b.textContent = on ? "■ Stopp" : "▶ Spill lanes";
    b.classList.toggle("primary", !on);
    b.classList.toggle("ghost", on);
    b.disabled = false; // stay clickable so you can stop mid-playback
  };
  $("auditionBtn").addEventListener("click", async () => {
    if (audition.playing) { audition.stop(); return; }
    const ok = await audition.play();
    if (!ok) setStatus("ingen slag å spille — ta opp litt perkusjon først");
  });
  $("auPre").addEventListener("input", (e) => {
    audition.preMs = +e.target.value; $("auPreV").textContent = audition.preMs + " ms"; save();
  });
  $("auPost").addEventListener("input", (e) => {
    audition.postMs = +e.target.value; $("auPostV").textContent = audition.postMs + " ms"; save();
  });
  $("auFade").addEventListener("input", (e) => {
    audition.fadeMs = +e.target.value; $("auFadeV").textContent = audition.fadeMs + " ms"; save();
  });
  $("auVol").addEventListener("input", (e) => {
    audition.masterGain = clamp((+e.target.value) / 100, 0, 1);
    if (audition._master) audition._master.gain.value = audition.masterGain;
    save();
  });

  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);
  }
  refreshDevices();
  requestAnimationFrame(renderLoop);
}

init();
