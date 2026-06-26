# Groove Grapher

A local, browser-based **percussion transient grapher + beat scale**. Record from
any microphone (built-in or external/USB interface) and watch each stroke —
bass, open tone, slap, or any percussion hit — light up on its own **pitch-band
timeline lane**. Add as many lanes as you like and assign each one a frequency
range. Then plot the detected hits onto a tempo-based **Highlight Scale**, swap
them for drum-kit sounds (or your own samples), drag them in time, and play the
groove back.

Everything runs **offline in your browser**. No audio ever leaves your computer.

![lanes](https://img.shields.io/badge/web%20audio-100%25%20local-4fd1c5)

---

## Run it

The app must be served over `http://localhost` (not opened as a `file://`).
That's required for two reasons: the microphone API only works in a "secure
context" (localhost counts), and ES-module `import`s won't load from `file://`.

From this folder:

```bash
# option A — the included helper
./run.sh

# option B — plain Python
python3 -m http.server 8000
```

Then open **http://localhost:8000** and click **Start**. Your browser will ask
for microphone permission the first time.

> Tip: Chrome/Edge give the most reliable results because they honor the
> "turn off all processing" microphone constraints. Firefox/Safari work too.

---

## How to use

1. **Pick a microphone** in the top-right dropdown (device names appear after you
   grant permission once), then press **Start**.
2. **Watch the spectrogram** at the top. Play a few strokes and you'll see where
   your bass / open / slap energy lands on the (log) frequency axis.
3. **Make lanes** three ways:
   - the **preset buttons** (Bass, Open, Slap, Tumba, Conga, Quinto, …),
   - **＋ Add lane** for a blank one, or
   - **drag vertically across the spectrogram** to create a lane for exactly the
     band you select.
4. **Tune each lane** in its header:
   - the two **Hz fields** set the pitch band,
   - **sens** = detection sensitivity (how big a jump counts as a hit),
   - **gain** = display gain for that lane's envelope,
   - **Mute** stops it from counting, **✕** removes it.
5. Use **Zoom** to stretch/compress time, **⏸ Freeze** to stop and inspect,
   **⌫ Clear** to reset, and **● Rec** to save the raw audio to a file.

Your lanes, zoom and device choice are saved in the browser, so they're still
there next time.

---

## The Highlight Scale (beat editor)

The panel at the bottom turns your captured hits into an editable, tempo-based
groove — like a mini arrangement view.

1. **Set the tempo & meter** — type a **BPM**, **Beats/bar** (time signature top
   number) and how many **Bars** the scale spans. The grid shows bars and beats
   so you can see exactly where you are; **pos** reads out `bar.beat.sixteenth`
   during playback.
2. **Clap/play your pattern** into the lanes above, then press
   **→ Send hits to scale**. Each lane becomes a **track**, and every detected
   hit is plotted at its real time, converted to beats at the current BPM. (The
   scale auto-grows its bar count to fit.)
3. **Replace the claps with sounds** — each track has a **sound dropdown**
   (Kick, Snare, Hats, Clap, Conga, Clave, Cowbell, Shaker, …). Click the
   colored dot to **preview**. Want your own sound? Hit **Load** and pick any
   audio file to use as that track's sample.
4. **Move / edit the hits** — **drag** a hit to shift it in time (it snaps to the
   **Snap** grid: ¼, ⅛, 1⁄16, or off). **Click an empty row** to add a hit,
   **right-click** (or select + Delete) to remove one.
5. **Play it back** with **▶ Play**; toggle **↻ Loop** to loop the bars. A
   playhead sweeps the grid in time with the sound.

The scale (tempo, tracks, sounds, hits) is saved in the browser too. Loaded
samples are kept for the session only — re-load them next time.

> Tip: set the BPM *before* sending hits if you want the plotted positions to
> land on the grid; then nudge with drag + snap to tighten the groove.

---

## Conga frequency cheat‑sheet

Tuning isn't standardized in Hz, so treat these as starting points and adjust to
your drums using the spectrogram.

| Lane            | Range (Hz)   | What it catches |
|-----------------|--------------|-----------------|
| Bass tone       | 50–130       | Low palm thump in the center |
| Open tone       | 150–300      | Ringing finger-on-edge fundamental |
| Slap            | 2000–6000    | Sharp broadband crack (~5 kHz) — best slap detector |
| Tumba           | 80–150       | Largest/lowest drum's open fundamental |
| Conga / segundo | 150–260      | Mid drum (~200–240 Hz) |
| Quinto          | 240–400      | Smallest/highest drum |
| Harmonics       | 300–900      | Overtones (~400 & ~700 Hz) — confirms a tuned tone |
| Slap crack      | 4000–8000    | High "pop"; closed slaps live here |

**Two things to know:**
- Lanes **overlap on purpose**. One stroke can register in several lanes — an
  open slap shows in both a pitch lane *and* the Slap lane.
- The **Slap band (2–6 kHz) is the most reliable discriminator**: slaps light it
  up strongly; bass and open tones barely touch it. Bass tones leak a little
  energy into every band, so "loudest in the low band" alone isn't enough to
  call something a bass tone — check the slap band too.

---

## How it works (the short version)

- One `AudioContext` captures the mic with **all browser DSP off**
  (echo cancellation / noise suppression / auto-gain) so transients and levels
  stay honest. The mic is **never routed to the speakers** (no feedback).
- A single `AnalyserNode` FFT runs each animation frame
  (`smoothingTimeConstant = 0` for crisp attacks).
- **Each lane** sums the FFT **power** inside its band, then runs an adaptive
  **energy-envelope onset detector**: a fast envelope vs. a slow, *asymmetric*
  baseline, firing when the fast level jumps past `sensitivity ×` the baseline,
  with an ~80 ms refractory so one hit can't double-count.
- The **spectrogram** maps FFT bins onto a log-frequency axis and scrolls in
  lock-step with the lanes so the time axes line up.

Source is plain ES modules under [`js/`](js/):
`audio-engine.js` (capture + FFT loop), `lane.js` (band detection + drawing),
`spectrogram.js` (spectrogram + drag-to-create), `presets.js`, `main.js` (UI).

---

## Troubleshooting

- **"mic error" / nothing happens** — make sure you opened `http://localhost:…`,
  not the file directly, and that you allowed microphone access.
- **No device names in the dropdown** — they only appear after you grant
  permission once; press Start, then they'll populate.
- **Too many / too few marks** — lower/raise that lane's **sens** slider. For
  fast rolls you can also lower the refractory in `js/lane.js` (`REFRACTORY_MS`).
- **Low bands blur together** — raise **FFT** to 8192 for finer low-frequency
  resolution (at the cost of slightly slower response).
- **External interface not listed** — click the **⟳** refresh button (the app
  also auto-refreshes on hot-plug).
