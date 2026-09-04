/* Classic script, not a module — see tutorial.js for why.

   ==========================================================================
   AI OPPONENT

   Produces an input record, exactly like a human or a network peer. The
   simulation has no idea it exists: `{sel, tx, ty, ta}` goes into
   server.inputs and stepWorld treats it identically to anything else.

   Three stages per plan:

     PREDICT  copy the world and run the REAL physics forward until the ball
              reaches somewhere this side can reach. Not a heuristic — the
              same stepBall the game uses, so bounces off walls and the net
              are accounted for exactly. Paddles are skipped: our own would
              make it circular, and we cannot know where the human's will be.

     AIM      solve the launch angle that lands the ball in the far goal, then
              work backwards to the paddle angle that produces it. The ball
              arcs under gravity, so aiming straight at the goal always falls
              short.

     CHOOSE   with two paddles, decide which one is going to take it, and
              refuse to change its mind for switchTime.

   Difficulty is three human limits rather than a speed multiplier: how late it
   reacts, how badly it aims, and how long it dithers over which paddle.
   ========================================================================== */
const AI = {
  on: false,
  reaction: 0.18,     // s — how stale its view of the ball is, and how often
                      //     it re-plans. This is perception delay, not speed.
  accuracy: 0.85,     // 0..1 — 1 aims exactly, 0 is hopeless
  switchTime: 0.35,   // s — deliberation before committing to the other paddle
};

const AI_LEVELS = {
  easy:   { reaction: 0.34, accuracy: 0.55, switchTime: 0.70 },
  normal: { reaction: 0.18, accuracy: 0.85, switchTime: 0.35 },
  hard:   { reaction: 0.09, accuracy: 0.97, switchTime: 0.16 },
};

const AI_HIST = 128;          // ticks of ball history, for delayed perception
const AI_PRED_DT = 1 / 120;   // coarser than the sim: prediction is cheap, and
                              // half a tick of error is far below the aim error
const AI_PRED_MAX = 4.0;      // s to look ahead before giving up. A wider
                              // court under lower gravity means longer flights,
                              // and a horizon shorter than the flight makes the
                              // AI believe nothing is coming.

const ai = {
  side: -1,
  hist: null,           // ring of past ball states
  head: 0,
  filled: 0,
  replan: 0,            // countdown to the next plan
  world: null,          // scratch world for prediction
  // the current plan
  tx: 0, ty: 0, ta: 0, sel: 0,
  wantSel: 0, selHeld: 0,
  hasPlan: false,
};

function aiInit(side) {
  ai.side = side;
  ai.head = 0;
  ai.filled = 0;
  ai.replan = 0;
  ai.hasPlan = false;
  ai.wantSel = ai.sel = 0;
  ai.selHeld = 0;
  if (!ai.hist) {
    ai.hist = new Array(AI_HIST);
    for (let i = 0; i < AI_HIST; i++) ai.hist[i] = { x: 0, y: 0, vx: 0, vy: 0, w: 0 };
  }
  if (!ai.world) ai.world = makeWorld();
}

/* Registered rather than called from startGame: this state belongs to the AI,
   so the knowledge that it needs clearing belongs here too. */
onNewGame(() => aiInit(-mySide));

function aiSetLevel(name) {
  const L = AI_LEVELS[name] || AI_LEVELS.normal;
  AI.reaction = L.reaction;
  AI.accuracy = L.accuracy;
  AI.switchTime = L.switchTime;
  try { localStorage.setItem('banjoball.ai', name); } catch (e) {}
}

/* Perception is delayed, not degraded. Every tick the true ball state is
   recorded; planning reads the entry from `reaction` seconds ago. That is how
   a person is actually limited — they are not slower, they are looking at
   something slightly out of date. */
function aiSample(w) {
  const b = w.ball, h = ai.hist[ai.head];
  h.x = b.x; h.y = b.y; h.vx = b.vx; h.vy = b.vy; h.w = b.w;
  ai.head = (ai.head + 1) % AI_HIST;
  if (ai.filled < AI_HIST) ai.filled++;
}

function aiPerceived(dt) {
  const back = Math.min(ai.filled - 1, Math.max(0, Math.round(AI.reaction / dt)));
  return ai.hist[((ai.head - 1 - back) % AI_HIST + AI_HIST) % AI_HIST];
}

/* Launch angles that land at (tx,ty) from (px,py) at speed s under gravity g.
   BOTH solutions are returned. The flat one is the better shot — less time in
   the air to answer — but it is also the one that hits the net, and which of
   those matters depends on geometry the solver cannot see. The caller decides.
   Returns null when the target is out of range at that speed. */
function aiLaunchAngle(px, py, tx, ty, s, g) {
  const dx = tx - px, dy = ty - py;
  const x = Math.abs(dx);
  if (x < 1e-4) return null;
  const s2 = s * s;
  const disc = s2 * s2 - g * (g * x * x + 2 * dy * s2);
  if (disc < 0) return null;                       // cannot reach
  const root = Math.sqrt(disc);
  return { sign: Math.sign(dx),
           low:  Math.atan((s2 - root) / (g * x)),
           high: Math.atan((s2 + root) / (g * x)) };
}

/* Where a shot passes over the net, and whether that is above it. The net was
   short relative to the court when the flat shot was chosen unconditionally;
   it no longer is, so a shot picked purely for being fast now spends its life
   thudding into the net from the AI's own half. */
function aiClearsNet(px, py, theta, s, g, dx) {
  const dxn = A.width / 2 - px;
  if (dxn * dx <= 0 || Math.abs(dxn) > Math.abs(dx)) return true;   // not in the way
  const X = Math.abs(dxn), c = Math.cos(theta);
  if (Math.abs(c) < 1e-6) return true;                              // straight up
  const y = py + X * Math.tan(theta) - g * X * X / (2 * s * s * c * c);
  return y > A.netHeight + PHYS.ballR * 1.5;
}

/* Roughly how fast a paddle travels once it is up to speed. The position
   spring clamps its error, so the pull is constant beyond that distance and
   the paddle settles at a terminal velocity rather than accelerating without
   limit. Derived from the tuning rather than measured, so it stays honest when
   the feel is retuned. */
function aiPaddleTopSpeed() {
  const w = 2 * Math.PI * FEEL.posFreq;
  const maxE = Math.min(FEEL.maxError, FEEL.reach);
  return Math.max(0.5, w * maxE / (2 * FEEL.posDamp));
}

// Can either of this side's paddles actually be there in time?
function aiCanReach(w, side, hit) {
  const v = aiPaddleTopSpeed();
  let near = Infinity;
  for (let i = 0; i < (MATCH.paddles > 1 ? 2 : 1); i++) {
    const p = w.p[idOf(side, i)];
    near = Math.min(near, Math.hypot(hit.x - p.x, hit.y - p.y));
  }
  return near / v + 0.12 <= hit.t;      // the constant is the spring's ramp-up
}

/* The paddle angle that turns an incoming velocity into a desired outgoing
   direction. A bounce mirrors the velocity about the surface normal, so the
   normal bisects the reversed incoming direction and the outgoing one. The
   paddle's face normal is perpendicular to its long axis, hence the atan2. */
function aiPaddleAngleFor(vinx, viny, dirx, diry) {
  const vl = Math.hypot(vinx, viny);
  let nx, ny;
  if (vl < 0.05) { nx = dirx; ny = diry; }         // a still ball: just face it
  else { nx = dirx - vinx / vl; ny = diry - viny / vl; }
  const nl = Math.hypot(nx, ny);
  if (nl < 1e-6) return null;
  return Math.atan2(-nx / nl, ny / nl);
}

/* Run the real physics forward from the perceived ball state until it arrives
   somewhere one of our paddles could meet it. Paddles are excluded from the
   prediction, so this answers "where would the ball go if nobody touched it". */
function aiPredict(w, side) {
  const src = aiPerceived(FIXED_DT);
  const pw = ai.world;
  copyWorld(pw, w);
  const b = pw.ball;
  b.x = src.x; b.y = src.y; b.vx = src.vx; b.vy = src.vy; b.w = src.w;
  b.px = b.x; b.py = b.y;

  /* The band this side can operate in — COURT ONLY. paddleBoxes also returns
     the goal pocket for the defence paddle, and including it would have the AI
     aim at intercepts inside its own net. It would then park on the boundary
     between two boxes that do not touch, where nearestLegal flips between them
     and the pose jumps the width of the gap. A person never stands there; an
     AI aiming at a predicted point will stand there all day. */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < (MATCH.paddles > 1 ? 2 : 1); i++) {
    const bx = paddleBoxes(w.p[idOf(side, i)])[0];   // [0] is the court box
    lo = Math.min(lo, bx.x0); hi = Math.max(hi, bx.x1);
  }

  /* The ball is in reach for a stretch of its crossing, not an instant, so
     there is a choice of where along it to meet the ball. Taking the earliest
     point means committing to an intercept the paddle often cannot make — it
     sets off, arrives late, and does it again next plan. Take the first point
     it can actually be at instead, and fall back to the earliest only when
     none of them is reachable, since arriving late still beats not going. */
  let first = null;
  const steps = Math.floor(AI_PRED_MAX / AI_PRED_DT);
  for (let i = 0; i < steps; i++) {
    stepBall(pw, AI_PRED_DT, true, true);          // world collisions, no paddles
    const towardUs = side < 0 ? b.vx < 0 : b.vx > 0;
    if (towardUs && b.x >= lo && b.x <= hi) {
      const cand = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, t: i * AI_PRED_DT };
      if (!first) first = cand;
      if (aiCanReach(w, side, cand)) return cand;
    }
    if (b.x < -A.goalDepth || b.x > A.width + A.goalDepth) break;
  }
  return first;
}

// Station in front of our own goal, on the court.
function aiHome(w, side) {
  const sel = MATCH.paddles > 1 ? 1 : 0;
  const box = paddleBoxes(w.p[idOf(side, sel)])[0];
  ai.tx = (box.x0 + box.x1) / 2;
  ai.ty = Math.max(box.y0, Math.min(box.y1, (goalY0() + goalY1()) / 2));
  ai.ta = 0;
  ai.wantSel = sel;
  ai.hasPlan = true;
}

function aiPlan(w, side) {
  const hit = aiPredict(w, side);
  aiHome(w, side);            // a sane fallback, overwritten if there is a plan

  if (!hit) return;          // nothing coming: stay home

  // Aim at the far goal, with error that grows as accuracy falls.
  const err = 1 - AI.accuracy;
  const goalX = side < 0 ? A.width : 0;
  const goalMid = (goalY0() + goalY1()) / 2;
  const spread = (goalY1() - goalY0()) * 0.5 + 1.5;
  const aimY = goalMid + (Math.random() * 2 - 1) * spread * err;

  /* An estimate of how fast the ball will leave, not a speed the AI can pick —
     it only chooses where the face points. The floor is the speed that carries
     half the court at 45 degrees, so a slow ball still gets aimed at the goal
     rather than at an impossible solution. */
  const floor = Math.sqrt(Math.max(1, A.width * 0.5 * PHYS.gravity));
  const speed = Math.max(floor, Math.hypot(hit.vx, hit.vy) * 1.15);
  const shot = aiLaunchAngle(hit.x, hit.y, goalX, aimY, speed, PHYS.gravity);

  let dirx, diry;
  if (shot) {
    // Flat when it clears the net, lofted when it does not.
    let theta = shot.low;
    if (!aiClearsNet(hit.x, hit.y, theta, speed, PHYS.gravity, goalX - hit.x)) theta = shot.high;
    dirx = shot.sign * Math.cos(theta);
    diry = Math.sin(theta);
  } else {
    /* Nothing reaches the goal at this speed. Send it as far as it will go
       instead of at a fixed shallow slope that dies in the net: 45 degrees is
       the maximum-range launch, and clears comfortably. */
    dirx = (side < 0 ? 1 : -1) * Math.SQRT1_2;
    diry = Math.SQRT1_2;
  }

  let ta = aiPaddleAngleFor(hit.vx, hit.vy, dirx, diry);
  if (ta === null) ta = 0;
  ta += (Math.random() * 2 - 1) * 0.5 * err;        // aim wobble

  // Miss the intercept by a little when inaccurate, too — a bad opponent is
  // out of position as often as it is badly angled.
  const off = (Math.random() * 2 - 1) * 0.5 * err;

  ai.tx = hit.x;
  ai.ty = hit.y + off;
  ai.ta = ta;

  // Keep the target on the court for the same reason.
  const own = paddleBoxes(w.p[idOf(side, ai.wantSel)])[0];
  ai.tx = Math.max(own.x0, Math.min(own.x1, ai.tx));
  ai.ty = Math.max(own.y0, Math.min(own.y1, ai.ty));

  if (MATCH.paddles > 1) {
    // Whichever paddle's own zone the ball is actually arriving in.
    const boxA = paddleBoxes(w.p[idOf(side, 0)])[0];
    ai.wantSel = (hit.x >= boxA.x0 && hit.x <= boxA.x1) ? 0 : 1;
  } else {
    ai.wantSel = 0;
  }
  ai.hasPlan = true;
}

/* Called by the server each tick, in place of reading a network input. */
function aiFillInput(w, side, dst, dt) {
  if (!ai.hist) aiInit(side);
  aiSample(w);

  ai.replan -= dt;
  if (ai.replan <= 0 || !ai.hasPlan) {
    ai.replan = AI.reaction;
    aiPlan(w, side);
  }

  // Committing to a paddle takes time, and having committed it does not
  // immediately reconsider. Without this it flickers between the two whenever
  // the prediction crosses a zone boundary.
  if (MATCH.paddles > 1) {
    if (ai.wantSel !== ai.sel) {
      ai.selHeld += dt;
      if (ai.selHeld >= AI.switchTime) { ai.sel = ai.wantSel; ai.selHeld = 0; }
    } else {
      ai.selHeld = 0;
    }
  } else {
    ai.sel = 0;
  }

  // One non-finite number would hand the spring an impossible target, so the
  // plan is checked before it is ever handed over.
  if (!isFinite(ai.tx) || !isFinite(ai.ty) || !isFinite(ai.ta)) aiHome(w, side);

  dst.sel = ai.sel;
  dst.tx = ai.tx;
  dst.ty = ai.ty;
  dst.ta = ai.ta;
}
