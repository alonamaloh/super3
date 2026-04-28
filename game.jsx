// game.jsx — Super 3 game logic + AI
// Pure functions, no React.

const SUBBOARD_INDICES = [0,1,2,3,4,5,6,7,8];
const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];

// A board is { sub: [9 sub-boards] }.
// Each sub-board: { cells: [9 cells: 'X'|'O'|null], owner: 'X'|'O'|null }.
//
// There are no draws in this game. A sub-board can't reach 9 marks
// because the 5th-mark rule fires first; and the meta-board can't
// reach 9 owned without one player owning ≥5. So owner === 'D' and a
// game-level draw outcome are not representable here.
function makeInitialBoard() {
  return {
    sub: Array.from({length: 9}, () => ({
      cells: Array(9).fill(null),
      owner: null,
    })),
  };
}

function rollDie() {
  // Standard 1..6 dice. The 3×3 of sub-boards is labelled with the
  // possible sums of two dice:
  //   3 4 5
  //   6 7 8
  //   9 10 11
  // Snake-eyes (sum 2) and boxcars (sum 12) are the two special actions.
  return Math.floor(Math.random() * 6) + 1;
}

function rollDice() {
  return [rollDie(), rollDie()];
}

// Given a dice sum, what does the player do?
//   2     -> remove an opponent mark
//   3..11 -> play in sub-board (sum-3) OR cell (sum-3) of any sub-board
//   12    -> play any empty cell anywhere
function diceMode(sum) {
  if (sum === 2)  return 'remove';
  if (sum === 12) return 'wild';
  return 'place';
}

// Compute the set of legal moves.
// Returns array of { sub, cell, kind: 'place'|'remove' }.
function legalMoves(board, dice, currentPlayer) {
  const sum = dice[0] + dice[1];
  const mode = diceMode(sum);
  const moves = [];
  const opp = currentPlayer === 'X' ? 'O' : 'X';

  if (mode === 'remove') {
    // Remove an opponent mark from any unclaimed sub-board.
    for (let s = 0; s < 9; s++) {
      const sb = board.sub[s];
      if (sb.owner) continue;
      for (let c = 0; c < 9; c++) {
        if (sb.cells[c] === opp) {
          moves.push({ sub: s, cell: c, kind: 'remove' });
        }
      }
    }
    // If no opponent marks exist anywhere, the turn is forfeited (no moves).
    return moves;
  }

  if (mode === 'wild') {
    for (let s = 0; s < 9; s++) {
      const sb = board.sub[s];
      if (sb.owner) continue;
      for (let c = 0; c < 9; c++) {
        if (sb.cells[c] === null) {
          moves.push({ sub: s, cell: c, kind: 'place' });
        }
      }
    }
    return moves;
  }

  // place: target meta-position = sum - 3 (sums 3..11 → indices 0..8)
  const t = sum - 3;
  // Option A: any empty cell in sub-board t (if not claimed)
  if (!board.sub[t].owner) {
    for (let c = 0; c < 9; c++) {
      if (board.sub[t].cells[c] === null) {
        moves.push({ sub: t, cell: c, kind: 'place' });
      }
    }
  }
  // Option B: cell t in any sub-board (that isn't claimed)
  for (let s = 0; s < 9; s++) {
    if (s === t && !board.sub[t].owner) continue; // already covered above
    const sb = board.sub[s];
    if (sb.owner) continue;
    if (sb.cells[t] === null) {
      moves.push({ sub: s, cell: t, kind: 'place' });
    }
  }
  return moves;
}

// Determine the owner of a single sub-board after a move.
// Rules: 3-in-a-row wins; else, the player whose own-color mark
// count reaches 5 claims it (the player who places their 5th mark in
// the sub-board, before the opponent does, owns it).
function evaluateSubBoard(cells) {
  for (const [a,b,c] of WIN_LINES) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) {
      return cells[a];
    }
  }
  let xCount = 0, oCount = 0;
  for (const v of cells) {
    if (v === 'X') xCount++;
    else if (v === 'O') oCount++;
  }
  if (xCount >= 5) return 'X';
  if (oCount >= 5) return 'O';
  return null;
}

// Apply a move; returns a new board (immutable-ish).
function applyMove(board, move, player) {
  const newSub = board.sub.map((sb, i) => {
    if (i !== move.sub) return sb;
    const cells = sb.cells.slice();
    if (move.kind === 'remove') {
      cells[move.cell] = null;
    } else {
      cells[move.cell] = player;
    }
    const owner = sb.owner ?? evaluateSubBoard(cells);
    return { cells, owner };
  });
  return { sub: newSub };
}

// Game-level winner: meta-tic-tac-toe (3-in-a-row of sub-board owners)
// OR a player owning 5+ sub-boards. Returns 'X' | 'O' | null.
function evaluateGame(board) {
  const owners = board.sub.map(s => s.owner);
  for (const [a,b,c] of WIN_LINES) {
    if (owners[a] && owners[a] === owners[b] && owners[a] === owners[c]) {
      return owners[a];
    }
  }
  let xCount = 0, oCount = 0;
  for (const o of owners) {
    if (o === 'X') xCount++;
    else if (o === 'O') oCount++;
  }
  if (xCount >= 5) return 'X';
  if (oCount >= 5) return 'O';
  return null;
}

// Which winning line (if any) created the meta win? For animation.
function winningLine(board) {
  const owners = board.sub.map(s => s.owner);
  for (const line of WIN_LINES) {
    const [a,b,c] = line;
    if (owners[a] && owners[a] === owners[b] && owners[a] === owners[c]) {
      return line;
    }
  }
  return null;
}

// ── Simple AI ──────────────────────────────────────────────────────────────
// Heuristic scoring for a candidate move:
//  +1000 wins game
//  +200 claims a sub-board
//  +50 creates a 2-in-a-row threat in a sub-board
//  +30 plays in center of sub-board
//  +10 plays in center sub-board (5)
//  -100 the resulting position lets opponent obviously claim a sub-board (skipped — too costly)
function scoreMove(board, move, player) {
  const opp = player === 'X' ? 'O' : 'X';
  if (move.kind === 'remove') {
    // Removing is most valuable when opp is close to claiming a sub-board.
    const sb = board.sub[move.sub];
    let score = 5;
    // Count opp marks in sub.
    const oppCount = sb.cells.filter(c => c === opp).length;
    score += oppCount * 4;
    // If removing breaks an opp 2-in-a-row threat → big.
    for (const [a,b,c] of WIN_LINES) {
      const line = [sb.cells[a], sb.cells[b], sb.cells[c]];
      const oc = line.filter(v => v === opp).length;
      const ec = line.filter(v => v === null).length;
      if (oc === 2 && ec === 1 && [a,b,c].includes(move.cell)) score += 80;
    }
    return score;
  }
  const next = applyMove(board, move, player);
  const sbBefore = board.sub[move.sub];
  const sbAfter = next.sub[move.sub];
  let score = 0;

  // Wins game?
  const winner = evaluateGame(next);
  if (winner === player) score += 1000;
  if (winner === opp) score -= 1000;

  // Claims sub-board?
  if (!sbBefore.owner && sbAfter.owner === player) score += 200;
  if (!sbBefore.owner && sbAfter.owner === opp) score -= 200;

  // 2-in-a-row threats in this sub-board.
  for (const [a,b,c] of WIN_LINES) {
    const line = [sbAfter.cells[a], sbAfter.cells[b], sbAfter.cells[c]];
    const pc = line.filter(v => v === player).length;
    const ec = line.filter(v => v === null).length;
    if (pc === 2 && ec === 1) score += 25;
    const oc = line.filter(v => v === opp).length;
    if (oc === 2 && ec === 1) score -= 30; // we left a threat (rough)
  }

  // Center cell of sub-board
  if (move.cell === 4) score += 8;
  // Center sub-board
  if (move.sub === 4) score += 4;

  // Mark count progress towards 5.
  const playerCount = sbAfter.cells.filter(c => c === player).length;
  if (!sbAfter.owner && playerCount >= 3) score += playerCount * 3;

  // Tiny randomness for variety.
  score += Math.random() * 4;
  return score;
}

function chooseAIMove(board, dice, player) {
  const moves = legalMoves(board, dice, player);
  if (moves.length === 0) return null;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = scoreMove(board, m, player);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

Object.assign(window, {
  SUPER3: {
    makeInitialBoard, rollDice, rollDie, diceMode,
    legalMoves, applyMove, evaluateSubBoard, evaluateGame,
    winningLine, chooseAIMove, WIN_LINES,
  },
});
