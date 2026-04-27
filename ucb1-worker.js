// ucb1-worker.js — UCB1-at-root rollout agent for Super 3.
//
// Self-contained classic Web Worker. Receives:
//   { type: 'choose', board, dice, player, budget, reqId }
// and replies:
//   { reqId, move: {sub, cell}|null, stats: {rollouts, time_ms} }
//
// `dice` are the externally-displayed 1..6 values (sums 2..12). The
// engine's internal mapping (sum 0=remove, 1..9=meta-position, 10=wild)
// is recovered as `internalSum = externalSum - 2`, then everything
// inside the worker uses 0..10 sums.
//
// State is the bit-packed "30-bit accumulator" representation:
//   - per (sub-board, player) uint32 with 8 line counters at pos2..pos9
//     plus a per-player mark counter at pos0..pos1
//   - per-player meta-board uint32 with the same encoding
//   - per-(sub-board, player) 9-bit cell-occupancy bitmask
//   - 9-bit "decided" sub-boards bitmask
//   - per-sub-board total-mark counter (3 + count, so bit 3 fires at 5+)
//
// Win checks are a single AND: bit 2 of any line slot fires on
// 3-in-a-row (line counter init 1, +1 per cell-in-line → 4 after 3
// marks); bit 3 of pos1 fires on the carry from the 5th meta-mark
// (= 5 sub-boards owned). The sub-board "5 marks total" rule uses the
// separate total counter since the per-player accumulator only counts
// own-color marks.

const INIT_ACC  = 0o1111111103;
const WIN_MASK  = 0o4444444410;
const LINE_MASK = 0o4444444400;
const FULL      = 0x1FF;
const MAX_TURNS = 1000;
const MAGIC = [
  0o1001001001, 0o1000100001, 0o1000010101,
  0o0101000001, 0o0100101101, 0o0100010001,
  0o0011000101, 0o0010100001, 0o0010011001,
];

// ─── State ───────────────────────────────────────────────────────────

function newState() {
  const s = {
    subAccX:  new Uint32Array(9),
    subAccO:  new Uint32Array(9),
    metaAccX: INIT_ACC,
    metaAccO: INIT_ACC,
    cellsX:   new Uint16Array(9),
    cellsO:   new Uint16Array(9),
    decided:  0,
    total:    new Uint8Array(9),
    toMove:   0,
  };
  s.subAccX.fill(INIT_ACC);
  s.subAccO.fill(INIT_ACC);
  s.total.fill(3);
  return s;
}

function cloneState(s) {
  return {
    subAccX:  new Uint32Array(s.subAccX),
    subAccO:  new Uint32Array(s.subAccO),
    metaAccX: s.metaAccX,
    metaAccO: s.metaAccO,
    cellsX:   new Uint16Array(s.cellsX),
    cellsO:   new Uint16Array(s.cellsO),
    decided:  s.decided,
    total:    new Uint8Array(s.total),
    toMove:   s.toMove,
  };
}

// Build the bit-packed state from the GUI's board representation
// (sub[i].cells[c] = 'X'|'O'|null, sub[i].owner = 'X'|'O'|null).
function buildState(board, toMoveStr) {
  const s = newState();
  s.toMove = toMoveStr === 'X' ? 0 : 1;
  for (let sb = 0; sb < 9; sb++) {
    const sub = board.sub[sb];
    if (sub.owner === 'X' || sub.owner === 'O') {
      s.decided |= (1 << sb);
      if (sub.owner === 'X') s.metaAccX = (s.metaAccX + MAGIC[sb]) >>> 0;
      else                   s.metaAccO = (s.metaAccO + MAGIC[sb]) >>> 0;
      // Decided sub-boards' inner cells/totals are dead state — no rule
      // reads them.
    } else {
      for (let c = 0; c < 9; c++) {
        const m = sub.cells[c];
        if (m === 'X') {
          s.cellsX[sb]  |= (1 << c);
          s.subAccX[sb]  = (s.subAccX[sb] + MAGIC[c]) >>> 0;
          s.total[sb]++;
        } else if (m === 'O') {
          s.cellsO[sb]  |= (1 << c);
          s.subAccO[sb]  = (s.subAccO[sb] + MAGIC[c]) >>> 0;
          s.total[sb]++;
        }
      }
    }
  }
  return s;
}

// Apply a single move at the root with the given internal sum (0..10)
// at coordinate (sub, cell). Returns winner index (0/1) if the move
// ends the game, else -1. Flips s.toMove.
function applyMoveAtRoot(s, sum, sub, cell) {
  const cur = s.toMove;
  const opp = 1 - cur;
  let winner = -1;
  if (sum === 0) {
    if (opp === 0) {
      s.cellsX[sub] &= ~(1 << cell);
      s.subAccX[sub] = (s.subAccX[sub] - MAGIC[cell]) >>> 0;
    } else {
      s.cellsO[sub] &= ~(1 << cell);
      s.subAccO[sub] = (s.subAccO[sub] - MAGIC[cell]) >>> 0;
    }
    s.total[sub]--;
  } else {
    if (cur === 0) {
      s.cellsX[sub] |= (1 << cell);
      s.subAccX[sub] = (s.subAccX[sub] + MAGIC[cell]) >>> 0;
    } else {
      s.cellsO[sub] |= (1 << cell);
      s.subAccO[sub] = (s.subAccO[sub] + MAGIC[cell]) >>> 0;
    }
    s.total[sub]++;
    const acc = cur === 0 ? s.subAccX[sub] : s.subAccO[sub];
    const claimed = (acc & LINE_MASK) || ((s.total[sub] & 0x08) !== 0);
    if (claimed) {
      s.decided |= (1 << sub);
      if (cur === 0) {
        s.metaAccX = (s.metaAccX + MAGIC[sub]) >>> 0;
        if (s.metaAccX & WIN_MASK) winner = 0;
      } else {
        s.metaAccO = (s.metaAccO + MAGIC[sub]) >>> 0;
        if (s.metaAccO & WIN_MASK) winner = 1;
      }
    }
  }
  s.toMove = opp;
  return winner;
}

// ─── Rollout ────────────────────────────────────────────────────────

const _legalSub  = new Uint8Array(81);
const _legalCell = new Uint8Array(81);

function rollout(s) {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const d1 = (Math.random() * 6) | 0;
    const d2 = (Math.random() * 6) | 0;
    const sum = d1 + d2;
    const cur = s.toMove;
    const opp = 1 - cur;

    let n = 0;
    if (sum === 0) {
      const oppCells = opp === 0 ? s.cellsX : s.cellsO;
      for (let sb = 0; sb < 9; sb++) {
        if (s.decided & (1 << sb)) continue;
        const bits = oppCells[sb];
        for (let c = 0; c < 9; c++) {
          if (bits & (1 << c)) {
            _legalSub[n]  = sb;
            _legalCell[n] = c;
            n++;
          }
        }
      }
    } else if (sum >= 1 && sum <= 9) {
      const p = sum - 1;
      if (!(s.decided & (1 << p))) {
        const empty = (~(s.cellsX[p] | s.cellsO[p])) & FULL;
        for (let c = 0; c < 9; c++) {
          if (empty & (1 << c)) {
            _legalSub[n]  = p;
            _legalCell[n] = c;
            n++;
          }
        }
      }
      const cellMaskP = 1 << p;
      for (let sb = 0; sb < 9; sb++) {
        if (sb === p) continue;
        if (s.decided & (1 << sb)) continue;
        if (((s.cellsX[sb] | s.cellsO[sb]) & cellMaskP) === 0) {
          _legalSub[n]  = sb;
          _legalCell[n] = p;
          n++;
        }
      }
    } else {  // sum === 10
      for (let sb = 0; sb < 9; sb++) {
        if (s.decided & (1 << sb)) continue;
        const empty = (~(s.cellsX[sb] | s.cellsO[sb])) & FULL;
        for (let c = 0; c < 9; c++) {
          if (empty & (1 << c)) {
            _legalSub[n]  = sb;
            _legalCell[n] = c;
            n++;
          }
        }
      }
    }

    if (n === 0) { s.toMove = opp; continue; }

    const idx  = (Math.random() * n) | 0;
    const sb   = _legalSub[idx];
    const cell = _legalCell[idx];

    if (sum === 0) {
      if (opp === 0) {
        s.cellsX[sb] &= ~(1 << cell);
        s.subAccX[sb] = (s.subAccX[sb] - MAGIC[cell]) >>> 0;
      } else {
        s.cellsO[sb] &= ~(1 << cell);
        s.subAccO[sb] = (s.subAccO[sb] - MAGIC[cell]) >>> 0;
      }
      s.total[sb]--;
    } else {
      if (cur === 0) {
        s.cellsX[sb] |= (1 << cell);
        s.subAccX[sb] = (s.subAccX[sb] + MAGIC[cell]) >>> 0;
      } else {
        s.cellsO[sb] |= (1 << cell);
        s.subAccO[sb] = (s.subAccO[sb] + MAGIC[cell]) >>> 0;
      }
      s.total[sb]++;
      const acc = cur === 0 ? s.subAccX[sb] : s.subAccO[sb];
      const claimed = (acc & LINE_MASK) || ((s.total[sb] & 0x08) !== 0);
      if (claimed) {
        s.decided |= (1 << sb);
        if (cur === 0) {
          s.metaAccX = (s.metaAccX + MAGIC[sb]) >>> 0;
          if (s.metaAccX & WIN_MASK) return 0;
        } else {
          s.metaAccO = (s.metaAccO + MAGIC[sb]) >>> 0;
          if (s.metaAccO & WIN_MASK) return 1;
        }
      }
    }

    s.toMove = opp;
  }
  return -1;
}

// ─── UCB1 at root ───────────────────────────────────────────────────

function legalMovesAtRoot(s, sum) {
  const moves = [];
  const cur = s.toMove;
  const opp = 1 - cur;

  if (sum === 0) {
    const oppCells = opp === 0 ? s.cellsX : s.cellsO;
    for (let sb = 0; sb < 9; sb++) {
      if (s.decided & (1 << sb)) continue;
      const bits = oppCells[sb];
      for (let c = 0; c < 9; c++) {
        if (bits & (1 << c)) moves.push({ sub: sb, cell: c });
      }
    }
  } else if (sum >= 1 && sum <= 9) {
    const p = sum - 1;
    if (!(s.decided & (1 << p))) {
      const empty = (~(s.cellsX[p] | s.cellsO[p])) & FULL;
      for (let c = 0; c < 9; c++) {
        if (empty & (1 << c)) moves.push({ sub: p, cell: c });
      }
    }
    const cellMaskP = 1 << p;
    for (let sb = 0; sb < 9; sb++) {
      if (sb === p) continue;
      if (s.decided & (1 << sb)) continue;
      if (((s.cellsX[sb] | s.cellsO[sb]) & cellMaskP) === 0) {
        moves.push({ sub: sb, cell: p });
      }
    }
  } else {
    for (let sb = 0; sb < 9; sb++) {
      if (s.decided & (1 << sb)) continue;
      const empty = (~(s.cellsX[sb] | s.cellsO[sb])) & FULL;
      for (let c = 0; c < 9; c++) {
        if (empty & (1 << c)) moves.push({ sub: sb, cell: c });
      }
    }
  }
  return moves;
}

function ucb1Choose(rootState, sum, mePlayerStr, budget) {
  const me = mePlayerStr === 'X' ? 0 : 1;
  const moves = legalMovesAtRoot(rootState, sum);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const k = moves.length;
  const sumReward = new Float64Array(k);
  const visits    = new Uint32Array(k);
  const c = Math.SQRT2;

  // Pre-compute the post-move template state for each candidate so we
  // don't re-apply the root move on every rollout.
  const postStates       = new Array(k);
  const immediateWinners = new Int8Array(k);
  for (let i = 0; i < k; i++) {
    const s = cloneState(rootState);
    immediateWinners[i] = applyMoveAtRoot(s, sum, moves[i].sub, moves[i].cell);
    postStates[i] = s;
  }

  function rolloutFor(i) {
    const w = immediateWinners[i];
    if (w >= 0) return w === me ? 1.0 : 0.0;
    const s = cloneState(postStates[i]);
    const winner = rollout(s);
    if (winner === me) return 1.0;
    if (winner < 0)    return 0.5;
    return 0.0;
  }

  // Forced-exploration phase: visit each move once.
  for (let i = 0; i < k; i++) {
    sumReward[i] += rolloutFor(i);
    visits[i]++;
  }

  let total = k;
  while (total < budget) {
    const logN = Math.log(total);
    let bestI = 0;
    let bestV = -Infinity;
    for (let i = 0; i < k; i++) {
      const n    = visits[i];
      const mean = sumReward[i] / n;
      const ucb  = mean + c * Math.sqrt(logN / n);
      if (ucb > bestV) { bestV = ucb; bestI = i; }
    }
    sumReward[bestI] += rolloutFor(bestI);
    visits[bestI]++;
    total++;
  }

  // Pick the most-visited move (low-variance MCTS root pick).
  let bestI = 0;
  let bestN = 0;
  for (let i = 0; i < k; i++) {
    if (visits[i] > bestN) { bestN = visits[i]; bestI = i; }
  }
  return moves[bestI];
}

// ─── Message handler ────────────────────────────────────────────────

self.onmessage = (e) => {
  const data = e.data;
  if (data.type !== 'choose') return;

  const t0 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  const externalSum = data.dice[0] + data.dice[1];
  const internalSum = externalSum - 2;   // GUI uses 1..6 dice; engine 0..5
  const state       = buildState(data.board, data.player);
  const move        = ucb1Choose(state, internalSum, data.player, data.budget);
  const t1 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();

  self.postMessage({
    reqId: data.reqId,
    move:  move,
    stats: { rollouts: data.budget, time_ms: t1 - t0 },
  });
};
