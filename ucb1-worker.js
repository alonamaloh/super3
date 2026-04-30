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
//     plus a per-player own-mark counter at pos0..pos1
//   - per-player meta-board uint32 with the same encoding
//   - per-(sub-board, player) 9-bit cell-occupancy bitmask
//   - 9-bit "decided" sub-boards bitmask
//
// Win checks are a single AND on WIN_MASK = 0o4444444410:
//   - bit 2 of any line slot fires on 3-in-a-row (line counter init 1,
//     +1 per cell-in-line → 4 after 3 marks)
//   - bit 3 of pos1 fires on the carry from the 5th own-color mark
//     (own-mark counter init 3 in pos0; +1 per own placement; the
//     carry into pos1 happens as the count goes 4 → 5)
// So one AND on the placer's own accumulator covers both the
// 3-in-a-row claim and the 5-of-own-color claim.

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
    toMove:   0,
  };
  s.subAccX.fill(INIT_ACC);
  s.subAccO.fill(INIT_ACC);
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
      // Decided sub-boards' inner cells are dead state — no rule
      // reads them.
    } else {
      for (let c = 0; c < 9; c++) {
        const m = sub.cells[c];
        if (m === 'X') {
          s.cellsX[sb]  |= (1 << c);
          s.subAccX[sb]  = (s.subAccX[sb] + MAGIC[c]) >>> 0;
        } else if (m === 'O') {
          s.cellsO[sb]  |= (1 << c);
          s.subAccO[sb]  = (s.subAccO[sb] + MAGIC[c]) >>> 0;
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
  } else {
    if (cur === 0) {
      s.cellsX[sub] |= (1 << cell);
      s.subAccX[sub] = (s.subAccX[sub] + MAGIC[cell]) >>> 0;
    } else {
      s.cellsO[sub] |= (1 << cell);
      s.subAccO[sub] = (s.subAccO[sub] + MAGIC[cell]) >>> 0;
    }
    // Sub-board claim: 3-in-a-row OR placer's own count reaches 5.
    // Both checks live in the same WIN_MASK on the placer's accumulator.
    const acc = cur === 0 ? s.subAccX[sub] : s.subAccO[sub];
    const claimed = (acc & WIN_MASK) !== 0;
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
const _legalCls  = new Uint8Array(81);   // class for each legal move

// Move-class priorities for the heuristic-biased rollout. Lower number
// is better. Classification uses bit tricks on the per-(sub, player)
// accumulators so the cost is a few ops per candidate.
//
//   0 — wins the game
//   1 — claims a sub-board (3-in-a-row inside it OR 5th own-color mark)
//   2 — blocks opp's 3-in-a-row threat (cell sits on an opp 2-in-a-row line)
//   3 — move in the center sub-board (sub == 4)
//   4 — move in another middle-row sub-board (sub == 3 or 5)
//   5 — anything else
//
// Sum=0 (remove) moves get class 5 — the user's classification only
// applies to placements, and removes are rare enough (1/36 of dice)
// that biasing them isn't worth the extra logic.
const CLS_WIN        = 0;
const CLS_CLAIM      = 1;
const CLS_BLOCK      = 2;
const CLS_CENTRE_SUB = 3;
const CLS_MID_ROW    = 4;
const CLS_OTHER      = 5;

function classifyPlace(s, cur, sub, cell) {
  const myAcc  = (cur === 0 ? s.subAccX[sub] : s.subAccO[sub]);
  const newSub = (myAcc + MAGIC[cell]) >>> 0;
  // 3-in-a-row OR placer's own count reaches 5 — single AND on WIN_MASK.
  const claims = (newSub & WIN_MASK) !== 0;
  if (claims) {
    const myMeta  = (cur === 0 ? s.metaAccX : s.metaAccO);
    const newMeta = (myMeta + MAGIC[sub]) >>> 0;
    if ((newMeta & WIN_MASK) !== 0) return CLS_WIN;
    return CLS_CLAIM;
  }
  // Block check: would the OPPONENT close a 3-in-a-row by placing here?
  // (We don't worry about their 5-of-own carry — their own count
  // only changes when they place themselves.)
  const oppAcc = (cur === 0 ? s.subAccO[sub] : s.subAccX[sub]);
  if ((((oppAcc + MAGIC[cell]) >>> 0) & LINE_MASK) !== 0) return CLS_BLOCK;
  if (sub === 4) return CLS_CENTRE_SUB;
  if (sub === 3 || sub === 5) return CLS_MID_ROW;
  return CLS_OTHER;
}

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
      // Centre cell (idx 4) is reserved for the unique p == 4 roll.
      // Mask it out of option (a)'s empty bitmap when p != 4.
      if (!(s.decided & (1 << p))) {
        let empty = (~(s.cellsX[p] | s.cellsO[p])) & FULL;
        if (p !== 4) empty &= ~(1 << 4);
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
    } else {  // sum === 10: any empty NON-CENTRE cell, any undecided sub-board.
      const NON_CENTRE = FULL & ~(1 << 4);
      for (let sb = 0; sb < 9; sb++) {
        if (s.decided & (1 << sb)) continue;
        const empty = (~(s.cellsX[sb] | s.cellsO[sb])) & NON_CENTRE;
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

    // Tactical move pick: among legal placements, prefer (in order)
    // wins-game > claims-sub-board > blocks-opp's-3-in-a-row > rest.
    // Pick uniformly among the highest-class set. Removes (sum==0)
    // stay uniform — the user's classification is for placements.
    let idx;
    if (sum === 0) {
      idx = (Math.random() * n) | 0;
    } else {
      let bestClass = CLS_OTHER + 1;
      let bestCount = 0;
      for (let i = 0; i < n; i++) {
        let cls = classifyPlace(s, cur, _legalSub[i], _legalCell[i]);
        if (cls > CLS_BLOCK) cls = CLS_OTHER;  // tactical: collapse
        if (cls < bestClass) {
          bestClass = cls;
          bestCount = 1;
          _legalCls[0] = i;
        } else if (cls === bestClass) {
          _legalCls[bestCount++] = i;
        }
      }
      idx = _legalCls[(Math.random() * bestCount) | 0];
    }
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
    } else {
      if (cur === 0) {
        s.cellsX[sb] |= (1 << cell);
        s.subAccX[sb] = (s.subAccX[sb] + MAGIC[cell]) >>> 0;
      } else {
        s.cellsO[sb] |= (1 << cell);
        s.subAccO[sb] = (s.subAccO[sb] + MAGIC[cell]) >>> 0;
      }
      const acc = cur === 0 ? s.subAccX[sb] : s.subAccO[sb];
      const claimed = (acc & WIN_MASK) !== 0;
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
    // Same centre-cell rule as in rollout(): cell 4 is only legal in
    // option (a) when p == 4.
    if (!(s.decided & (1 << p))) {
      let empty = (~(s.cellsX[p] | s.cellsO[p])) & FULL;
      if (p !== 4) empty &= ~(1 << 4);
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
  } else {  // sum === 10: any empty NON-CENTRE cell.
    const NON_CENTRE = FULL & ~(1 << 4);
    for (let sb = 0; sb < 9; sb++) {
      if (s.decided & (1 << sb)) continue;
      const empty = (~(s.cellsX[sb] | s.cellsO[sb])) & NON_CENTRE;
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
  if (moves.length === 1) return { move: moves[0], rollouts: 0 };

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

  // UCB1 phase: run additional rollouts until `budget` is reached.
  // budget is a rollout count (not a wall-clock budget); the caller
  // gates the visible "AI thinking" pause separately (e.g. with a
  // 1 s sleep at the call site) so easy/medium feel deliberate.
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

  // Per-move stats for diagnostics: visits, mean reward (win rate
  // from this player's perspective), and best-mean rank for quick
  // comparison with the visit-based pick.
  const perMove = new Array(k);
  for (let i = 0; i < k; i++) {
    const n = visits[i];
    perMove[i] = {
      sub: moves[i].sub,
      cell: moves[i].cell,
      visits: n,
      mean: n > 0 ? sumReward[i] / n : 0,
    };
  }

  return { move: moves[bestI], rollouts: total, perMove };
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
  const result      = ucb1Choose(state, internalSum, data.player, data.budget);
  const t1 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();

  self.postMessage({
    reqId: data.reqId,
    move:  result ? result.move : null,
    stats: {
      rollouts: result ? result.rollouts : 0,
      time_ms:  t1 - t0,
      perMove:  result ? result.perMove : null,
    },
  });
};
