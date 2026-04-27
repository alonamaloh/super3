// sound.jsx — procedural dice-roll SFX via Web Audio.
// playRollSound(n) lays down `n` short noise bursts over a span scaled
// to `n`, so a 20-die round-start sounds like a clatter and a 2-die
// reroll sounds like a click or two.
//
// The splash-screen "Start game" tap satisfies iOS Safari's
// user-gesture requirement before the first round-start sound fires,
// so no queueing or special-case bootstrap is needed.

let _ctx = null;

function _ensureCtx() {
  if (_ctx) return _ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  _ctx = new Ctor();
  return _ctx;
}

// Call from inside a user-gesture handler (e.g. the "Start game"
// onClick) to unlock audio. Returns a promise that resolves once the
// context is running, so the caller can await before triggering any
// sounds. Chrome Android refuses to play if resume() hasn't finished.
async function unlockAudio() {
  const ctx = _ensureCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
}

// Belt-and-braces fallback: if audio is somehow still suspended after
// the splash (or there's no splash at all), the next pointerdown
// anywhere on the page will retry the unlock.
document.addEventListener('pointerdown', () => {
  const ctx = _ensureCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume();
}, { once: true });

function _scheduleClick(ctx, when, intensity = 1) {
  // Decaying noise burst, band-pass-filtered around 1.5–3 kHz so it
  // sounds like a small object skipping on a hard surface.
  const dur = 0.04 + Math.random() * 0.06;          // 40–100 ms
  const sampleCount = Math.max(1, Math.ceil(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleCount;
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 7);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1400 + Math.random() * 1800;
  filter.Q.value = 3 + Math.random() * 5;
  const gain = ctx.createGain();
  gain.gain.value = 0.22 * intensity;
  src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  src.start(when);
  src.stop(when + dur);
}

function playRollSound(numDice) {
  const ctx = _ensureCtx();
  if (!ctx || ctx.state !== 'running') return;
  const n = Math.max(1, Math.floor(numDice));
  // Span scales with count, capped so even 20-die rounds finish quickly.
  const span = Math.min(0.25 + n * 0.04, 1.1);
  const now = ctx.currentTime;
  for (let i = 0; i < n; i++) {
    // Bias the schedule earlier: most clicks happen in the first half
    // of the span, then a few stragglers tail off.
    const r = Math.random();
    const t = now + Math.pow(r, 0.7) * span;
    _scheduleClick(ctx, t, 0.6 + Math.random() * 0.4);
  }
}

// ─── Tonal cues ─────────────────────────────────────────────────────────
// Procedural oscillator with a quick attack and exponential decay. Used
// to compose short note sequences for sub-board claims and game-end.
function _scheduleTone(ctx, when, freq, dur, opts = {}) {
  const { type = 'triangle', gain = 0.16 } = opts;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.008);          // 8 ms attack
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);     // decay over `dur`
  osc.connect(g); g.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + dur + 0.02);
}

// notes: array of [freq, dur_ms] tuples played back-to-back.
function _playSequence(notes, gainScale = 1.0) {
  const ctx = _ensureCtx();
  if (!ctx || ctx.state !== 'running') return;
  let t = ctx.currentTime;
  for (const [freq, durMs] of notes) {
    const dur = durMs / 1000;
    _scheduleTone(ctx, t, freq, dur, { gain: 0.16 * gainScale });
    t += dur;
  }
}

// All cues live in C major / A minor (relative minor — every note is in
// the diatonic set of C). Positive cues resolve on C; negative cues on A.
// Positive and negative cues are mirrored in pacing, only the pitches
// and gain differ.
const _A4 = 440.00, _C5 = 523.25, _D5 = 587.33, _E5 = 659.25,
      _F5 = 698.46, _G5 = 783.99, _C6 = 1046.50;

// Sub-board claim — fires up to ~9× per game, so kept short.
//   forPlayer=true:  G5 → C6 (perfect 4th up, lands on tonic of C major)
//   forPlayer=false: E5 → A4 (perfect 5th down, lands on tonic of A minor;
//                    quieter so AI claims don't punish the player)
function playSubBoardWin(forPlayer) {
  if (forPlayer) {
    _playSequence([[_G5, 80], [_C6, 110]], 1.0);
  } else {
    _playSequence([[_E5, 80], [_A4, 110]], 0.65);
  }
}

// Game end — once per game, OK to be a small flourish.
//   forPlayer=true:  C5 → D5 → E5 → G5 → C6 (major walk-up, lands on tonic)
//   forPlayer=false: G5 → F5 → E5 → C5 → A4 (minor walk-down, lands on tonic)
function playGameEnd(forPlayer) {
  if (forPlayer) {
    _playSequence([[_C5, 110], [_D5, 110], [_E5, 110], [_G5, 110], [_C6, 240]], 1.05);
  } else {
    _playSequence([[_G5, 110], [_F5, 110], [_E5, 110], [_C5, 110], [_A4, 240]], 0.85);
  }
}

Object.assign(window, {
  playRollSound, unlockAudio, playSubBoardWin, playGameEnd,
});
