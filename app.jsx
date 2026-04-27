// app.jsx — Super 3 UI.
// Mobile-first. Dice on top, board on bottom (portrait); side-by-side
// (landscape — see CSS in Super 3.html).
//
// Single theme (Paper) and single mark style (bold). The Claude-Design
// source had developer toggles for theme/mark-style/coordinate-overlay
// via a TweaksPanel; that's stripped here so play-testers see a clean
// production UI.

const { useState, useEffect, useRef, useMemo, useCallback } = React;
const S3 = window.SUPER3;

// ─── Theme ──────────────────────────────────────────────────────────────────
const THEME = {
  bg:          '#f6f3ec',
  surface:     '#ffffff',
  line:        '#e4dfd2',
  lineStrong:  '#cfc7b3',
  text:        '#23211c',
  textMuted:   '#8a8474',
  x:           'oklch(58% 0.16 28)',   // warm clay red
  o:           'oklch(58% 0.16 240)',  // cool blue
  accent:      'oklch(58% 0.16 28)',
  legalBg:     'rgba(0,0,0,0.04)',
  legalRing:   'rgba(0,0,0,0.18)',
  illegal:     '#aaa39b',
  claimedBg:   '#fbf8f0',
};

// ─── Glyphs (X / O) — SVG in 100-unit viewBox ──────────────────────────────
function GlyphX({ size = 24, color, weight = 'normal', css }) {
  const sw = weight === 'big' ? 12 : 11;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={css}
         stroke={color} fill="none">
      <line x1="18" y1="18" x2="82" y2="82" strokeWidth={sw} strokeLinecap="round" />
      <line x1="82" y1="18" x2="18" y2="82" strokeWidth={sw} strokeLinecap="round" />
    </svg>
  );
}

function GlyphO({ size = 24, color, weight = 'normal', css }) {
  const sw = weight === 'big' ? 12 : 11;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={css}
         stroke={color} fill="none">
      <circle cx="50" cy="50" r="32" strokeWidth={sw} />
    </svg>
  );
}

// ─── Die ────────────────────────────────────────────────────────────────────
// Standard 1..6 dice with the classic pip layout: 1 centre, 2 diagonal
// corners, 3 corners + centre, 4 four corners, 5 four corners + centre,
// 6 two columns of three.
const PIP_POS = {
  TL: [27, 27], TR: [73, 27],
  ML: [27, 50], MR: [73, 50],
  BL: [27, 73], BR: [73, 73],
  C:  [50, 50],
};
const PIP_LAYOUT = {
  1: ['C'],
  2: ['TL', 'BR'],
  3: ['TL', 'C', 'BR'],
  4: ['TL', 'TR', 'BL', 'BR'],
  5: ['TL', 'TR', 'C', 'BL', 'BR'],
  6: ['TL', 'ML', 'BL', 'TR', 'MR', 'BR'],
};

function DieFace({ value, fill, pipColor, size }) {
  const positions = (PIP_LAYOUT[value] || []).map(k => PIP_POS[k]);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: 'block' }}>
      <rect x="3" y="3" width="94" height="94" rx="22" ry="22" fill={fill} />
      <rect x="3" y="3" width="94" height="46" rx="22" ry="22"
            fill="url(#dieHi)" opacity="0.18" />
      {positions.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="7.2" fill={pipColor} />
      ))}
    </svg>
  );
}

function DieDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        <linearGradient id="dieHi" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity="0.9" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function Die({ value, rolling, color }) {
  // While `rolling`, flicker through random faces; settle on `value`.
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    if (!rolling) { setDisplay(value); return; }
    const id = setInterval(() => {
      setDisplay(Math.floor(Math.random() * 6) + 1);
    }, 70);
    const stop = setTimeout(() => {
      clearInterval(id);
      setDisplay(value);
    }, 520);
    return () => { clearInterval(id); clearTimeout(stop); };
  }, [rolling, value]);

  const SIZE = 84;
  return (
    <div style={{
      width: SIZE, height: SIZE,
      transition: 'transform .25s cubic-bezier(.2,.8,.2,1)',
      transform: rolling ? 'rotate(-6deg) scale(0.96)' : 'rotate(0) scale(1)',
      filter: 'drop-shadow(0 6px 12px rgba(40, 30, 90, 0.18))',
    }}>
      <DieFace value={display} fill={color} pipColor="#ffffff" size={SIZE} />
    </div>
  );
}

// ─── Mark (a placed glyph in a cell) ───────────────────────────────────────
function Mark({ value }) {
  if (!value) return null;
  const color = value === 'X' ? THEME.x : THEME.o;
  const Glyph = value === 'X' ? GlyphX : GlyphO;
  return (
    <div style={{
      animation: 'mark-in .22s cubic-bezier(.2,.8,.2,1) both',
      position: 'absolute',
      inset: '12%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      <Glyph size="100%" color={color} />
    </div>
  );
}

// ─── Cell ──────────────────────────────────────────────────────────────────
// `isLegal` controls the highlight (used on both turns so the AI's
// candidate moves are visible). `clickable` is the actionable subset —
// set only on the human's turn.
function Cell({ value, isLegal, clickable, onClick, removeMode }) {
  return (
    <button
      onClick={onClick}
      disabled={!clickable}
      style={{
        position: 'relative',
        appearance: 'none', border: 'none', padding: 0, margin: 0,
        background: 'transparent',
        boxShadow: isLegal ? `inset 0 0 0 1.5px ${THEME.text}` : 'none',
        cursor: clickable ? 'pointer' : 'default',
        borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%',
        transition: 'box-shadow .15s',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Mark value={value} />
      {removeMode && value && isLegal && (
        <span style={{
          position: 'absolute', inset: 0,
          background: 'rgba(220, 60, 60, 0.12)',
          borderRadius: 6,
          boxShadow: 'inset 0 0 0 1.5px rgba(220, 60, 60, 0.55)',
        }} />
      )}
    </button>
  );
}

// ─── Sub-board ─────────────────────────────────────────────────────────────
function SubBoard({ index, sub, legalCells, clickable, onCellClick, removeMode,
                    justClaimedAt, claimSeq }) {
  const isClaimed = !!sub.owner;
  const showBigGlyph = sub.owner === 'X' || sub.owner === 'O';
  const bigColor = sub.owner === 'X' ? THEME.x : sub.owner === 'O' ? THEME.o : THEME.textMuted;
  const justClaimed = justClaimedAt === index;

  return (
    <div style={{
      position: 'relative',
      background: isClaimed ? THEME.claimedBg : THEME.surface,
      borderRadius: 10,
      padding: 4,
      overflow: 'hidden',
      boxShadow: `inset 0 0 0 1px ${THEME.line}`,
    }}>
      {/* Cell grid */}
      <div style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gridTemplateRows: '1fr 1fr 1fr',
        gap: 1,
        background: THEME.line,
        borderRadius: 6,
        overflow: 'hidden',
        aspectRatio: '1 / 1',
        opacity: isClaimed ? 0 : 1,
        transition: 'opacity .35s ease',
      }}>
        {sub.cells.map((v, c) => {
          const legal = legalCells.has(c);
          return (
            <div key={c} style={{
              background: THEME.surface,
              position: 'relative',
            }}>
              <Cell
                value={v}
                isLegal={legal}
                clickable={clickable && legal}
                onClick={() => onCellClick(index, c)}
                removeMode={removeMode}
              />
            </div>
          );
        })}
      </div>

      {/* Sub-board number watermark, low-opacity, until claimed */}
      {!isClaimed && (
        <svg
          aria-hidden="true"
          width="100%"
          height="100%"
          viewBox="0 0 100 100"
          preserveAspectRatio="xMidYMid meet"
          style={{
            position: 'absolute', inset: 4,
            width: 'calc(100% - 8px)', height: 'calc(100% - 8px)',
            pointerEvents: 'none',
            opacity: 0.07,
            mixBlendMode: 'multiply',
          }}
        >
          <text
            x="50" y="58"
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily='"JetBrains Mono", monospace'
            fontWeight="700"
            fontSize="78"
            fill={THEME.text}
            letterSpacing="-3"
          >{index + 3}</text>
        </svg>
      )}

      {/* Big claim glyph */}
      {showBigGlyph && (
        <div
          key={`claim-${index}-${claimSeq}`}
          style={{
            position: 'absolute', inset: '8%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: justClaimed ? 'claim-pop .55s cubic-bezier(.2,.9,.2,1.1) both' : 'none',
            pointerEvents: 'none',
          }}>
          {sub.owner === 'X'
            ? <GlyphX size="100%" color={bigColor} weight="big" />
            : <GlyphO size="100%" color={bigColor} weight="big" />}
        </div>
      )}
    </div>
  );
}

// ─── Board ─────────────────────────────────────────────────────────────────
function Board({ board, legalMap, clickable, onCellClick, removeMode, justClaimedAt, claimSeq }) {
  return (
    <div style={{
      width: '100%',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gridTemplateRows: '1fr 1fr 1fr',
      gap: 6,
      aspectRatio: '1 / 1',
    }}>
      {board.sub.map((sub, i) => (
        <SubBoard
          key={i}
          index={i}
          sub={sub}
          legalCells={legalMap.get(i) || new Set()}
          clickable={clickable}
          onCellClick={onCellClick}
          removeMode={removeMode}
          justClaimedAt={justClaimedAt}
          claimSeq={claimSeq}
        />
      ))}
    </div>
  );
}

function ModeChip({ mode, sum, phase }) {
  let label, color;
  if (phase === 'no-moves') {
    label = 'No legal moves — turn skipped';
    color = THEME.textMuted;
  } else if (mode === 'remove') {
    label = 'Snake eyes — remove an opponent mark';
    color = THEME.x;
  } else if (mode === 'wild') {
    label = 'Boxcars — wild, play anywhere';
    color = THEME.accent;
  } else {
    label = `Target board ${sum} or cell ${sum}`;
    color = THEME.text;
  }
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '8px 16px',
      borderRadius: 999,
      background: THEME.surface,
      border: `1px solid ${THEME.line}`,
      fontFamily: 'Inter, sans-serif',
      fontSize: 15,
      color: color,
      fontWeight: 500,
    }}>
      {label}
    </div>
  );
}

// ─── Rules overlay ─────────────────────────────────────────────────────────
function RulesOverlay({ onClose }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 70,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      background: THEME.bg,
      fontFamily: 'Inter, sans-serif',
      color: THEME.text,
      overflowY: 'auto',
      padding: '32px 22px 80px',
    }}>
      <div style={{ maxWidth: 460, lineHeight: 1.55, fontSize: 15 }}>
        <h2 style={{
          fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em',
          margin: '0 0 16px',
        }}>
          How to play
        </h2>

        <p style={{ margin: '0 0 14px' }}>
          The board is a 3×3 grid of tic-tac-toe sub-boards, themselves
          labelled 3..11 in row-major order. On each turn the active
          player rolls two standard six-sided dice. The sum tells you what
          to do:
        </p>

        <ul style={{ margin: '0 0 14px', paddingLeft: 20 }}>
          <li><b>2</b> (snake eyes) — Remove one of your opponent's marks from any undecided sub-board.</li>
          <li><b>3–11</b> — Call this sum <i>N</i>. Place a mark either anywhere in sub-board <i>N</i>, or in cell <i>N</i> of any other undecided sub-board.</li>
          <li><b>12</b> (boxcars) — Place a mark on any empty cell of any undecided sub-board.</li>
        </ul>

        <p style={{ margin: '0 0 18px', color: THEME.textMuted }}>
          If the dice leave you no legal action, your turn is skipped.
        </p>

        <h3 style={{
          fontSize: 16, fontWeight: 600, letterSpacing: '-0.005em',
          margin: '0 0 8px',
        }}>
          Claiming a sub-board
        </h3>
        <p style={{ margin: '0 0 18px' }}>
          A sub-board is yours as soon as you either complete three-in-a-row
          inside it, or place the fifth mark in it. Once claimed, the sub-board
          is locked — no more marks can be placed or removed there.
        </p>

        <h3 style={{
          fontSize: 16, fontWeight: 600, letterSpacing: '-0.005em',
          margin: '0 0 8px',
        }}>
          Winning
        </h3>
        <p style={{ margin: '0 0 24px' }}>
          You win when you either complete three-in-a-row of claimed
          sub-boards on the meta-grid, or claim five or more sub-boards.
        </p>

        <button onClick={onClose} style={{
          appearance: 'none',
          background: THEME.accent,
          color: '#fff',
          border: 'none',
          padding: '12px 28px',
          borderRadius: 999,
          fontSize: 15, fontWeight: 600, fontFamily: 'Inter, sans-serif',
          cursor: 'pointer',
        }}>Back</button>
      </div>
    </div>
  );
}

const _splashLinkStyle = {
  appearance: 'none',
  background: 'transparent',
  color: THEME.textMuted,
  border: 'none',
  padding: '8px 8px',
  fontSize: 14, fontWeight: 500, fontFamily: 'Inter, sans-serif',
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
};

// ─── Credits overlay ───────────────────────────────────────────────────────
function CreditsOverlay({ onClose }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 70,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: THEME.bg,
      fontFamily: 'Inter, sans-serif',
      color: THEME.text,
      padding: '32px 22px',
    }}>
      <div style={{ maxWidth: 360, textAlign: 'center', lineHeight: 1.6, fontSize: 16 }}>
        <h2 style={{
          fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em',
          margin: '0 0 18px',
        }}>
          Credits
        </h2>
        <p style={{ margin: '0 0 8px' }}>
          Original game design by Alan Newman.
        </p>
        <p style={{ margin: '0 0 28px' }}>
          Programmed by Álvaro Begué, with Claude (Anthropic).
        </p>
        <button onClick={onClose} style={{
          appearance: 'none',
          background: THEME.accent,
          color: '#fff',
          border: 'none',
          padding: '12px 28px',
          borderRadius: 999,
          fontSize: 15, fontWeight: 600, fontFamily: 'Inter, sans-serif',
          cursor: 'pointer',
        }}>Back</button>
      </div>
    </div>
  );
}

// ─── Splash overlay ────────────────────────────────────────────────────────
// First-load gate. Two reasons:
//   1. iOS Safari and friends require a user gesture before any
//      AudioContext can leave the 'suspended' state. We can't play the
//      first roll's clatter without one.
//   2. Gives the player a clear "press to begin" beat, which feels
//      better than landing mid-roll.
// On tap we await unlockAudio() and then kick off the first turn.
function SplashOverlay({ onStart, onShowRules, onShowCredits }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: THEME.bg,
      fontFamily: 'Inter, sans-serif',
    }}>
      <div style={{ textAlign: 'center', padding: 24 }}>
        <div style={{
          fontSize: 15, color: THEME.textMuted,
          fontWeight: 500, marginBottom: 4,
        }}>
          Alan Newman's
        </div>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8,
          fontSize: 44, fontWeight: 700, letterSpacing: '-0.02em',
          color: THEME.text,
          marginBottom: 32,
        }}>
          <span>Super</span>
          <span style={{
            fontFamily: '"JetBrains Mono", monospace',
            color: THEME.accent,
          }}>3</span>
        </div>
        <button onClick={onStart} style={{
          appearance: 'none',
          background: THEME.accent,
          color: '#fff',
          border: 'none',
          padding: '14px 36px',
          borderRadius: 999,
          fontSize: 16, fontWeight: 700, fontFamily: 'Inter, sans-serif',
          cursor: 'pointer',
          boxShadow: '0 6px 18px rgba(0,0,0,0.14)',
        }}>Tap to start</button>
        <div style={{
          marginTop: 14,
          display: 'flex', justifyContent: 'center', gap: 6,
        }}>
          <button onClick={onShowRules} style={_splashLinkStyle}>Game rules</button>
          <span style={{ color: THEME.textMuted, alignSelf: 'center' }}>·</span>
          <button onClick={onShowCredits} style={_splashLinkStyle}>Credits</button>
        </div>
      </div>
    </div>
  );
}

// ─── Win overlay ───────────────────────────────────────────────────────────
function WinOverlay({ phase, onMenu }) {
  const title = phase === 'win-x' ? 'You win' : 'AI wins';
  const sub   = phase === 'win-x' ? 'meta tic-tac-toe achieved' : 'better luck next time';
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(20,20,20,0.32)',
      backdropFilter: 'blur(6px)',
      animation: 'fade-in .3s ease both',
    }}>
      <div style={{
        background: THEME.surface,
        border: `1px solid ${THEME.line}`,
        borderRadius: 18,
        padding: '24px 28px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        textAlign: 'center',
        minWidth: 240,
      }}>
        <div style={{
          fontFamily: 'Inter, sans-serif',
          fontSize: 24, fontWeight: 700, color: THEME.text,
          letterSpacing: '-0.01em',
        }}>{title}</div>
        <div style={{
          fontSize: 12, color: THEME.textMuted, marginTop: 6,
        }}>{sub}</div>
        <button onClick={onMenu} style={{
          marginTop: 16,
          appearance: 'none',
          background: THEME.accent,
          color: '#fff',
          border: 'none',
          padding: '9px 18px',
          borderRadius: 999,
          fontSize: 13, fontWeight: 600, fontFamily: 'Inter, sans-serif',
          cursor: 'pointer',
        }}>Main menu</button>
      </div>
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────
function App() {
  const [board, setBoard] = useState(() => S3.makeInitialBoard());
  const [dice, setDice] = useState(() => S3.rollDice());
  const [rolling, setRolling] = useState(false);
  const [currentPlayer, setCurrentPlayer] = useState('X'); // X = human, O = AI
  // Start in 'splash': first-load gate so we have a user gesture before
  // the first roll's clatter fires (Chrome Android refuses to play if
  // ctx.resume() hasn't finished).
  const [phase, setPhase] = useState('splash');
  const [justClaimedAt, setJustClaimedAt] = useState(null);
  const [claimSeq, setClaimSeq] = useState(0);
  const [moveLog, setMoveLog] = useState([]);
  const [showRules, setShowRules] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  const aiTimer = useRef(null);
  // Remembers who opened the previous game so we can alternate seats
  // across games. null on the very first game (then we coin-flip).
  const lastStarterRef = useRef(null);

  const sum = dice[0] + dice[1];
  const mode = S3.diceMode(sum);

  // Compute legal moves for the current player.
  const moves = useMemo(() => {
    if (phase !== 'player-turn' && phase !== 'ai-thinking') return [];
    return S3.legalMoves(board, dice, currentPlayer);
  }, [board, dice, currentPlayer, phase]);

  // Build legalMap: subIdx → Set of cell indices. Only on the human's
  // turn — highlighting AI candidates makes the squares look tappable
  // when they aren't.
  const legalMap = useMemo(() => {
    const m = new Map();
    if (phase !== 'player-turn') return m;
    for (const mv of moves) {
      if (!m.has(mv.sub)) m.set(mv.sub, new Set());
      m.get(mv.sub).add(mv.cell);
    }
    return m;
  }, [moves, phase]);

  // Start a fresh turn: roll dice for `player` against `currentBoard`,
  // then either prompt them to play or — if the dice produced no legal
  // move — skip and recurse for the other player. (No draws: we just
  // keep cycling until somebody gets a legal roll. In practice that's
  // immediate, since sum=10 (1/36) always lets you play anywhere.)
  const startTurn = useCallback((player, currentBoard) => {
    setCurrentPlayer(player);
    setRolling(true);
    setPhase('rolling');
    const nd = S3.rollDice();
    setDice(nd);
    if (typeof window.playRollSound === 'function') {
      window.playRollSound(2);  // 2 dice → quick clatter
    }
    setTimeout(() => {
      setRolling(false);
      const result = S3.evaluateGame(currentBoard);
      if (result === 'X') return setPhase('win-x');
      if (result === 'O') return setPhase('win-o');
      const lm = S3.legalMoves(currentBoard, nd, player);
      if (lm.length === 0) {
        setPhase('no-moves');
        setTimeout(() => {
          startTurn(player === 'X' ? 'O' : 'X', currentBoard);
        }, 1100);
        return;
      }
      setPhase(player === 'X' ? 'player-turn' : 'ai-thinking');
    }, 560);
  }, []);

  // Apply a move and pass turn.
  const playMove = useCallback((move, player) => {
    const next = S3.applyMove(board, move, player);
    let claimed = null;
    for (let i = 0; i < 9; i++) {
      if (!board.sub[i].owner && next.sub[i].owner) { claimed = i; break; }
    }
    setBoard(next);
    setMoveLog(l => [...l, { player, move, dice }]);
    const result = S3.evaluateGame(next);
    if (claimed !== null) {
      setJustClaimedAt(claimed);
      setClaimSeq(s => s + 1);
      setTimeout(() => setJustClaimedAt(null), 700);
      // Skip the sub-board cue when the same move ends the game —
      // the game-end flourish is the more meaningful sound to lead with.
      if (!result && typeof window.playSubBoardWin === 'function') {
        window.playSubBoardWin(player === 'X');
      }
    }
    if (result) {
      if (typeof window.playGameEnd === 'function') {
        window.playGameEnd(result === 'X');
      }
      setTimeout(() => {
        setPhase(result === 'X' ? 'win-x' : 'win-o');
      }, claimed !== null ? 600 : 0);
      return;
    }
    const nextPlayer = player === 'X' ? 'O' : 'X';
    setTimeout(() => {
      startTurn(nextPlayer, next);
    }, claimed !== null ? 700 : 240);
  }, [board, dice, startTurn]);

  // Spin up a single Web Worker for UCB1 rollouts and reuse it across
  // turns. Outstanding requests live in a Map keyed by reqId so a
  // late-arriving reply (e.g. for a turn that was abandoned because
  // the user hit "New game") can be silently dropped.
  const ucb1WorkerRef = useRef(null);
  const ucb1PendingRef = useRef(new Map());
  const ucb1ReqIdRef = useRef(0);
  useEffect(() => {
    const w = new Worker('ucb1-worker.js');
    w.onmessage = (e) => {
      const { reqId, move, stats } = e.data;
      const resolver = ucb1PendingRef.current.get(reqId);
      if (resolver) {
        ucb1PendingRef.current.delete(reqId);
        resolver({ move, stats });
      }
    };
    w.onerror = (e) => console.error('ucb1 worker error', e.message || e);
    ucb1WorkerRef.current = w;
    return () => {
      w.terminate();
      ucb1WorkerRef.current = null;
      ucb1PendingRef.current.clear();
    };
  }, []);

  const askUcb1 = useCallback((board, dice, player, budget) => {
    return new Promise((resolve) => {
      const w = ucb1WorkerRef.current;
      if (!w) { resolve({ move: null, stats: null }); return; }
      const reqId = ++ucb1ReqIdRef.current;
      ucb1PendingRef.current.set(reqId, resolve);
      w.postMessage({ type: 'choose', board, dice, player, budget, reqId });
    });
  }, []);

  // AI turn handler — UCB1-at-root, run in a Web Worker so the rollout
  // budget doesn't block dice flicker / animation on the main thread.
  // Fallback to the heuristic AI if the worker is unavailable.
  useEffect(() => {
    if (phase !== 'ai-thinking') return;
    let cancelled = false;
    aiTimer.current = setTimeout(async () => {
      try {
        const { move } = await askUcb1(board, dice, 'O', /* budget */ 2000);
        if (cancelled) return;
        // The worker returns {sub, cell}; reconstruct the GUI's full
        // move record (with `kind`) by looking it up in legalMoves.
        const legal = S3.legalMoves(board, dice, 'O');
        let chosen = move
          ? legal.find(m => m.sub === move.sub && m.cell === move.cell)
          : null;
        if (!chosen) chosen = S3.chooseAIMove(board, dice, 'O');
        if (chosen) playMove(chosen, 'O');
      } catch (e) {
        console.error('ucb1 turn failed; falling back to heuristic', e);
        const fallback = S3.chooseAIMove(board, dice, 'O');
        if (!cancelled && fallback) playMove(fallback, 'O');
      }
    }, 750);
    return () => { cancelled = true; clearTimeout(aiTimer.current); };
  }, [phase, board, dice, playMove, askUcb1]);

  const handleCellClick = (subIdx, cellIdx) => {
    if (phase !== 'player-turn') return;
    const move = moves.find(m => m.sub === subIdx && m.cell === cellIdx);
    if (!move) return;
    playMove(move, 'X');
  };

  // Pick the next opening seat: random on the very first game, then
  // alternate (so a long session has equal first-move counts for each
  // side). Updates the ref as a side effect so successive calls keep
  // alternating.
  const nextStarter = () => {
    const last = lastStarterRef.current;
    const starter = last == null
      ? (Math.random() < 0.5 ? 'X' : 'O')
      : (last === 'X' ? 'O' : 'X');
    lastStarterRef.current = starter;
    return starter;
  };

  // First user gesture handler — unlocks audio (Chrome Android needs
  // ctx.resume() to resolve before the first sound) and starts play.
  const startFromSplash = useCallback(async () => {
    if (typeof window.unlockAudio === 'function') {
      try { await window.unlockAudio(); } catch {}
    }
    startTurn(nextStarter(), S3.makeInitialBoard());
  }, [startTurn]);

  const newGame = () => {
    const fresh = S3.makeInitialBoard();
    setBoard(fresh);
    setMoveLog([]);
    setJustClaimedAt(null);
    // Audio is already unlocked by this point (the splash button or any
    // prior tap), so we can roll straight away.
    startTurn(nextStarter(), fresh);
  };

  // End-of-game action: clean up the board and return to the splash
  // screen so the player can choose to start again, view the rules,
  // etc. The next round of play happens via the splash's Tap-to-start.
  const backToMenu = () => {
    setBoard(S3.makeInitialBoard());
    setMoveLog([]);
    setJustClaimedAt(null);
    setPhase('splash');
  };

  return (
    <div className="s3-root" style={{
      minHeight: '100vh',
      background: THEME.bg,
      color: THEME.text,
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      boxSizing: 'border-box',
    }}>
      <div className="s3-shell">
        <div className="s3-side">
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{
                fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em',
              }}>Super</span>
              <span style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 22, fontWeight: 700, color: THEME.accent,
                letterSpacing: '-0.02em',
              }}>3</span>
            </div>
            <button onClick={newGame} style={{
              appearance: 'none', border: `1px solid ${THEME.line}`,
              background: THEME.surface, color: THEME.text,
              padding: '6px 12px', borderRadius: 999,
              fontSize: 12, fontFamily: 'Inter, sans-serif', fontWeight: 500,
              cursor: 'pointer',
            }}>New game</button>
          </div>

          {/* Dice */}
          <div style={{
            padding: '18px 14px 14px',
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <DieDefs />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <Die value={dice[0]} rolling={rolling}
                   color={currentPlayer === 'X' ? THEME.x : THEME.o} />
              <Die value={dice[1]} rolling={rolling}
                   color={currentPlayer === 'X' ? THEME.x : THEME.o} />
            </div>
            {/* Bubble: only on the human's turn, and only after the dice
                have settled (otherwise it would reveal the roll's
                result before the flicker animation does). The wrapper
                always occupies its slot so the rest of the layout
                doesn't shift when the chip is hidden. */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              visibility: (currentPlayer === 'X' &&
                           (phase === 'player-turn' || phase === 'no-moves'))
                ? 'visible' : 'hidden',
            }}>
              <ModeChip mode={mode} sum={sum} phase={phase} />
            </div>
          </div>
        </div>

        {/* Board */}
        <div className="s3-board-wrap">
          <Board
            board={board}
            legalMap={legalMap}
            clickable={phase === 'player-turn'}
            onCellClick={handleCellClick}
            removeMode={mode === 'remove' && currentPlayer === 'X'}
            justClaimedAt={justClaimedAt}
            claimSeq={claimSeq}
          />
        </div>
      </div>

      {phase === 'splash' && !showRules && !showCredits && (
        <SplashOverlay
          onStart={startFromSplash}
          onShowRules={() => setShowRules(true)}
          onShowCredits={() => setShowCredits(true)}
        />
      )}
      {phase === 'splash' && showRules && (
        <RulesOverlay onClose={() => setShowRules(false)} />
      )}
      {phase === 'splash' && showCredits && (
        <CreditsOverlay onClose={() => setShowCredits(false)} />
      )}
      {(phase === 'win-x' || phase === 'win-o') && (
        <WinOverlay phase={phase} onMenu={backToMenu} />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
