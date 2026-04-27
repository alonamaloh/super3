// policy.jsx — drives the AI seat with the ONNX-exported Super3Net.
//
// Mirrors python/general_games/policies/super3.py:
//   * encodeObs(...)     ↔ encode(snap)
//   * moveFeatures(...)  ↔ _legal_move_features(prompt)
// The exported graph (policy.onnx) takes (obs[191], move_features[n,18])
// and returns scores[n]; we argmax to pick a move.

const OBS_DIM       = 191;
const MOVE_FEAT_DIM = 18;
const SUM_RANGE     = 11;
const BOARDS        = 9;
const CELLS         = 9;

// Match the WASM bundle to the umd script tag in Super 3.html.
ort.env.wasm.wasmPaths =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
// Single-threaded WASM avoids needing COOP/COEP headers for
// SharedArrayBuffer; the model is tiny so threading wouldn't help anyway.
ort.env.wasm.numThreads = 1;

let _session = null;
let _sessionPromise = null;

function loadPolicy(path = 'policy.onnx') {
  if (_session) return Promise.resolve(_session);
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = ort.InferenceSession.create(path, {
    executionProviders: ['wasm'],
  }).then((s) => { _session = s; return s; });
  return _sessionPromise;
}

// ── Encoding (perspective-relative; mirrors Python `encode`) ──────────────
// Layout:
//   my_marks       (81)   — sub-boards × cells, perspective player's marks
//   opp_marks      (81)
//   my_owned_subs  (9)    — sub-boards owned by perspective player
//   opp_owned_subs (9)
//   sum_one_hot    (11)   — dice sum (0..10) one-hot
function encodeObs(board, sum, perspective /* 'X' or 'O' */) {
  const me  = perspective;
  const opp = perspective === 'X' ? 'O' : 'X';
  const obs = new Float32Array(OBS_DIM);
  let idx = 0;
  // my_marks
  for (let sb = 0; sb < BOARDS; sb++) {
    const row = board.sub[sb].cells;
    for (let c = 0; c < CELLS; c++) {
      if (row[c] === me) obs[idx] = 1.0;
      idx++;
    }
  }
  // opp_marks
  for (let sb = 0; sb < BOARDS; sb++) {
    const row = board.sub[sb].cells;
    for (let c = 0; c < CELLS; c++) {
      if (row[c] === opp) obs[idx] = 1.0;
      idx++;
    }
  }
  // my_owned_subs
  for (let sb = 0; sb < BOARDS; sb++) {
    if (board.sub[sb].owner === me) obs[idx] = 1.0;
    idx++;
  }
  // opp_owned_subs
  for (let sb = 0; sb < BOARDS; sb++) {
    if (board.sub[sb].owner === opp) obs[idx] = 1.0;
    idx++;
  }
  // sum one-hot. The trained NN was trained on a 0..10 sum range
  // (snake-eyes=0, boxcars=10). The GUI now uses standard 1..6 dice,
  // so external sums are 2..12 — remap by subtracting 2 here so the
  // NN sees what it expects.
  const internalSum = sum - 2;
  if (internalSum >= 0 && internalSum < SUM_RANGE) {
    obs[idx + internalSum] = 1.0;
  }
  idx += SUM_RANGE;
  return obs;
}

// Per-move features: sub_one_hot (9) + cell_one_hot (9) = 18.
function moveFeatures(legalMoves) {
  const n = legalMoves.length;
  const flat = new Float32Array(n * MOVE_FEAT_DIM);
  for (let i = 0; i < n; i++) {
    const m = legalMoves[i];
    flat[i * MOVE_FEAT_DIM + m.sub] = 1.0;
    flat[i * MOVE_FEAT_DIM + BOARDS + m.cell] = 1.0;
  }
  return flat;
}

async function _scoreMoves(obs, moveFeatsFlat, nMoves) {
  const sess = await loadPolicy();
  const obsTensor   = new ort.Tensor('float32', obs, [obs.length]);
  const movesTensor = new ort.Tensor('float32', moveFeatsFlat, [nMoves, MOVE_FEAT_DIM]);
  const out = await sess.run({ obs: obsTensor, move_features: movesTensor });
  return Array.from(out.scores.data);   // length nMoves
}

function _argmax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}

// High-level: pick the AI's move greedily from the trained policy.
// Returns one of the moves from window.SUPER3.legalMoves(...) or null
// if the policy has no legal options (forfeit-skip case).
async function policyChooseMove(board, dice, player) {
  const sum = dice[0] + dice[1];
  const moves = window.SUPER3.legalMoves(board, dice, player);
  if (moves.length === 0) return null;
  const obs = encodeObs(board, sum, player);
  const feats = moveFeatures(moves);
  const scores = await _scoreMoves(obs, feats, moves.length);
  return moves[_argmax(scores)];
}

Object.assign(window, {
  loadPolicy, encodeObs, moveFeatures, policyChooseMove,
});
