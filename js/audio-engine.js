// AudioEngine: microphone capture, device selection, a single shared FFT loop,
// and optional raw recording. Listeners receive one analysis "frame" per
// animation tick and do their own band math / drawing.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;

    this.running = false;
    this.fftSize = 4096;

    this.freqDb = null;   // Float32Array, dB per bin (from AnalyserNode)
    this.freqLin = null;  // Float32Array, linear magnitude this frame
    this.prevLin = null;  // Float32Array, linear magnitude previous frame
    this.binHz = 0;
    this.deviceId = null;

    this._raf = 0;
    this._resuming = false;
    this._listeners = new Set();

    this.recorder = null;
    this._recChunks = [];

    // Ring of past frames for retroactive lane replay (90 s window).
    // Each entry: { t, freqLin: Float32Array (copy), binHz, nyquist }
    this._frameHistory = [];
    this._histPrune = 0;

    // Rolling raw-PCM ring buffer (mono) for audition playback, kept in lockstep
    // with the spectral history above so the same window is available as sound.
    // Filled by a ScriptProcessor tap off the mic source. ~90 s @ ctx rate.
    this.AUDIO_SEC = 90;
    this._ring = null;
    this._ringCap = 0;
    this._writePos = 0;      // total samples ever written (monotonic)
    this._audioStartT = -1;  // ctx time of global ring sample index 0
    this._cap = null;        // ScriptProcessorNode
    this._capSink = null;    // zero-gain sink so the tap runs without feedback
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }
  get nyquist() { return this.sampleRate / 2; }

  onFrame(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  // Enumerate audio inputs. Labels are only populated once the user has granted
  // mic permission at least once, so call start() (or _ensurePermission) first
  // for human-readable device names.
  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  }

  // Trigger a permission prompt without keeping the stream, so device labels
  // become available before the user picks one.
  async ensurePermission() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch (e) {
      return false;
    }
  }

  async start(deviceId) {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();

    await this._openStream(deviceId);

    if (!this.running) {
      this.running = true;
      this._loop();
    }
  }

  // Switch device live, without tearing down the AudioContext or render loop.
  async switchDevice(deviceId) {
    if (!this.ctx) return this.start(deviceId);
    await this._openStream(deviceId);
  }

  async _openStream(deviceId) {
    // Disable all browser DSP — it would mangle transients and levels.
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      // Chosen device gone (unplugged) -> fall back to the system default.
      if (err && err.name === "OverconstrainedError" && deviceId) {
        delete audio.deviceId;
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        deviceId = null;
      } else {
        throw err;
      }
    }

    // Tear down any previous stream/source.
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.source) this.source.disconnect();

    this.stream = stream;
    this.deviceId = deviceId || stream.getAudioTracks()[0]?.getSettings().deviceId || null;
    this.source = this.ctx.createMediaStreamSource(stream);

    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.minDecibels = -120;
      this.analyser.maxDecibels = 0;
      this.analyser.smoothingTimeConstant = 0; // raw frames -> responsive transients
    }
    this.analyser.fftSize = this.fftSize;
    this.source.connect(this.analyser);
    // NOTE: deliberately NOT connecting analyser -> destination (would feed back).

    this._allocBuffers();
    this._setupCapture();
  }

  // ---- Rolling raw-PCM capture (for audition playback) ----
  // A ScriptProcessorNode is deprecated but universally supported and needs no
  // separate worklet module (handy for a zero-build local tool). We only READ
  // its input and route its (silent) output through a zero-gain sink to the
  // destination, which is what keeps onaudioprocess firing without any feedback.
  _setupCapture() {
    this._teardownCapture();
    if (!this.ctx || !this.source) return;
    const sr = this.sampleRate;
    if (!this._ring) {
      this._ringCap = Math.ceil(this.AUDIO_SEC * sr);
      this._ring = new Float32Array(this._ringCap);
      this._writePos = 0;
      this._audioStartT = -1;
    }
    let sp;
    try { sp = this.ctx.createScriptProcessor(4096, 1, 1); }
    catch (e) { return; }
    sp.onaudioprocess = (e) => {
      const inp = e.inputBuffer.getChannelData(0);
      const n = inp.length;
      const sr = this.sampleRate;
      const blockStartT = this.ctx.currentTime - n / sr;
      // Stamp the time of global sample 0 once, so onset timestamps
      // (ctx.currentTime) map linearly to PCM offsets: t = startT + g/sr.
      if (this._audioStartT < 0) this._audioStartT = blockStartT;
      const ring = this._ring, cap = this._ringCap;
      // Preserve that linear mapping across real-time GAPS (device switch,
      // context suspend/resume) by padding silence for the skipped span. The
      // `> n` guard ignores normal sub-block jitter so it can't slowly drift.
      let gap = Math.round((blockStartT - this._audioStartT) * sr) - this._writePos;
      if (gap > n) {
        if (gap > cap) gap = cap;
        for (let i = 0; i < gap; i++) { ring[this._writePos % cap] = 0; this._writePos++; }
      }
      let w = this._writePos % cap;
      for (let i = 0; i < n; i++) { ring[w] = inp[i]; if (++w >= cap) w = 0; }
      this._writePos += n;
    };
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(sp);
    sp.connect(sink);
    sink.connect(this.ctx.destination);
    this._cap = sp;
    this._capSink = sink;
  }

  _teardownCapture() {
    if (this._cap) { try { this._cap.disconnect(); } catch (e) {} this._cap.onaudioprocess = null; this._cap = null; }
    if (this._capSink) { try { this._capSink.disconnect(); } catch (e) {} this._capSink = null; }
  }

  // The [t0, t1] (ctx-clock seconds) currently held in the PCM ring, or null.
  audioRange() {
    if (!this._ring || this._audioStartT < 0 || this._writePos === 0) return null;
    const sr = this.sampleRate;
    const oldest = Math.max(0, this._writePos - this._ringCap);
    return {
      t0: this._audioStartT + oldest / sr,
      t1: this._audioStartT + this._writePos / sr,
      sampleRate: sr,
    };
  }

  // Mono Float32 slice for [tStart, tEnd) in ctx-clock seconds; zero-filled where
  // audio isn't (or is no longer) available in the ring.
  getAudioSlice(tStart, tEnd) {
    const sr = this.sampleRate;
    const len = Math.max(0, Math.round((tEnd - tStart) * sr));
    const out = new Float32Array(len);
    if (!this._ring || this._audioStartT < 0 || len === 0) return out;
    const cap = this._ringCap;
    const gStart = Math.round((tStart - this._audioStartT) * sr);
    const oldest = Math.max(0, this._writePos - cap);
    for (let i = 0; i < len; i++) {
      const g = gStart + i;
      if (g >= oldest && g < this._writePos) out[i] = this._ring[((g % cap) + cap) % cap];
    }
    return out;
  }

  clearAudio() {
    this._writePos = 0;
    this._audioStartT = -1;
    if (this._ring) this._ring.fill(0);
  }

  _allocBuffers() {
    const bins = this.analyser.frequencyBinCount;
    this.freqDb = new Float32Array(bins);
    this.freqLin = new Float32Array(bins);
    this.prevLin = new Float32Array(bins);
    this.binHz = this.sampleRate / this.fftSize;
  }

  setFftSize(n) {
    this.fftSize = n;
    if (this.analyser) {
      this.analyser.fftSize = n;
      this._allocBuffers();
    }
  }

  freqToBin(hz) { return Math.round(hz / this.binHz); }

  _loop() {
    const tick = () => {
      if (!this.running) return;

      // Self-heal if the context was auto-suspended (mobile backgrounding,
      // audio-focus loss): skip analysis this frame and try to resume, instead
      // of reading stale/frozen data off a suspended context.
      if (this.ctx.state !== "running") {
        if (!this._resuming) {
          this._resuming = true;
          this.ctx.resume().catch(() => {}).finally(() => { this._resuming = false; });
        }
        this._raf = requestAnimationFrame(tick);
        return;
      }

      this.analyser.getFloatFrequencyData(this.freqDb);

      // Swap buffers so prevLin holds last frame, then fill freqLin from dB.
      const tmp = this.prevLin;
      this.prevLin = this.freqLin;
      this.freqLin = tmp;

      const db = this.freqDb;
      const lin = this.freqLin;
      for (let i = 0; i < db.length; i++) {
        const d = db[i];
        lin[i] = !isFinite(d) || d <= -119 ? 0 : Math.pow(10, d / 20);
      }

      const frame = {
        t: this.ctx.currentTime,
        freqDb: this.freqDb,
        freqLin: this.freqLin,
        prevLin: this.prevLin,
        binHz: this.binHz,
        sampleRate: this.sampleRate,
        nyquist: this.nyquist,
      };
      for (const fn of this._listeners) fn(frame);

      // Keep a copy of freqLin so lanes added later can replay history.
      this._frameHistory.push({
        t: frame.t,
        freqLin: new Float32Array(this.freqLin),
        binHz: this.binHz,
        nyquist: this.nyquist,
      });
      // Prune entries older than 90 s — batch to once per second to avoid
      // O(n) splice every frame.
      if (++this._histPrune >= 60) {
        this._histPrune = 0;
        const cutoff = frame.t - 90;
        let i = 0;
        while (i < this._frameHistory.length && this._frameHistory[i].t < cutoff) i++;
        if (i > 0) this._frameHistory.splice(0, i);
      }

      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.stopRecording();
    this._teardownCapture(); // keep the ring's DATA so post-stop audition works
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.source) { this.source.disconnect(); this.source = null; }
    // Release the audio hardware while idle; start() resumes it again.
    if (this.ctx && this.ctx.state === "running") this.ctx.suspend().catch(() => {});
  }

  // Feed all stored frames into a newly created lane so it sees the full
  // recorded history instead of starting blank. We supply prevLin (the prior
  // frame's spectrum) so the lane's spectral-flux transient detector behaves the
  // same on recompute as it does live; the first frame has no predecessor.
  replayHistory(lane) {
    let prevLin = null;
    for (const f of this._frameHistory) {
      lane.process(prevLin ? { t: f.t, freqLin: f.freqLin, prevLin, binHz: f.binHz, nyquist: f.nyquist } : f);
      prevLin = f.freqLin;
    }
  }

  // ---- Raw recording (WebM/Opus or whatever the browser supports) ----
  isRecording() { return !!this.recorder && this.recorder.state === "recording"; }

  startRecording() {
    if (!this.stream || this.isRecording()) return false;
    const chunks = [];
    this._recChunks = chunks;
    let mime = "";
    for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"]) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) { mime = m; break; }
    }
    let rec;
    try {
      rec = mime ? new MediaRecorder(this.stream, { mimeType: mime })
                 : new MediaRecorder(this.stream);
    } catch (e) {
      return false;
    }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    // Wire the download at creation time so it fires no matter WHY the recorder
    // stops — including the browser auto-stopping it when the source tracks end
    // (e.g. switching input device mid-recording). Otherwise the buffered audio
    // would be silently discarded.
    rec.onstop = () => {
      if (this.recorder === rec) this.recorder = null;
      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ext = (rec.mimeType || "webm").includes("ogg") ? "ogg" : "webm";
      a.href = url;
      a.download = `conga-recording.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };
    this.recorder = rec;
    rec.start();
    return true;
  }

  stopRecording() {
    const rec = this.recorder;
    if (!rec) return;
    // onstop (wired in startRecording) performs the download.
    if (rec.state === "recording") rec.stop();
    else this.recorder = null;
  }
}
