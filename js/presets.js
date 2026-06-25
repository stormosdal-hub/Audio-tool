// Pitch-band presets for congas, validated against acoustic analysis.
//
// There are two complementary families and they intentionally OVERLAP:
//   • STROKE family — Bass / Open tone / Slap, regardless of which drum.
//   • DRUM family    — Tumba / Conga / Quinto open-tone fundamentals.
// A single stroke can legitimately light up several lanes (an open slap shows
// in both the Quinto-pitch lane and the Slap lane) — that's expected.
//
// IMPORTANT: conga tuning is NOT standardized in Hz — players tune to intervals
// or to a song's key. These are sensible defaults; use the spectrogram to see
// where YOUR strokes land and drag the band edges to match. The most reliable
// single discriminator is the Slap band (~2–6 kHz): slaps light it up, bass and
// open tones barely touch it.

export const PRESETS = [
  // --- Stroke type ---
  { name: "Bass tone",  group: "stroke", minHz: 50,   maxHz: 130,  color: "#60a5fa",
    note: "Low palm thump in the drum center. Strong here + little 2–6 kHz = bass." },
  { name: "Open tone",  group: "stroke", minHz: 150,  maxHz: 300,  color: "#34d399",
    note: "Ringing finger-on-edge fundamental. Varies with drum size & tuning." },
  { name: "Slap",       group: "stroke", minHz: 2000, maxHz: 6000, color: "#f59e0b",
    note: "Sharp broadband crack centered ~5 kHz. Best slap-vs-tone discriminator." },

  // --- Which drum (open-tone fundamentals) ---
  { name: "Tumba",      group: "drum",   minHz: 80,   maxHz: 150,  color: "#a78bfa",
    note: "Largest/lowest drum open fundamental (often ~E2–A2)." },
  { name: "Conga",      group: "drum",   minHz: 150,  maxHz: 260,  color: "#4fd1c5",
    note: "Mid drum; membrane mode commonly 200–240 Hz (~G3 to middle C)." },
  { name: "Quinto",     group: "drum",   minHz: 240,  maxHz: 400,  color: "#f472b6",
    note: "Smallest/highest drum, ~a fourth above the conga (C4–G4)." },

  // --- Extras ---
  { name: "Harmonics",  group: "extra",  minHz: 300,  maxHz: 900,  color: "#c084fc",
    note: "First overtones (~400 & ~700 Hz) — confirms a tuned tone vs a pitchless slap." },
  { name: "Slap crack", group: "extra",  minHz: 4000, maxHz: 8000, color: "#fb7185",
    note: "The high 'pop' of open/closed slaps. Closed slaps live almost entirely here." },
];

// Names of the lanes seeded on first run (no saved state yet).
export const STARTER_LANES = ["Bass tone", "Open tone", "Slap"];
