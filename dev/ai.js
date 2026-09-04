/* Classic script, not a module — see tutorial.js for why.

   ==========================================================================
   AI OPPONENT

   Produces an input record, exactly like a human or a network peer. The
   simulation has no idea it exists: `{sel, tx, ty, ta}` goes into
   server.inputs and stepWorld treats it identically to anything else.

   THREE CLOCKS.

     perception   the ball is read `reaction` seconds stale, always
     plan         every `commit` seconds: predict, choose a stroke, build a path
     tick         240 Hz: evaluate the path, emit a target. No decisions.

   The plan is a motor program; the tick is the muscle. Between plans the AI
   cannot see anything new and cannot reconsider — it can only execute the
   stroke it committed to. That is the whole point. An earlier version emitted
   ONE frozen coordinate per plan, so its target was a staircase at 5 Hz while
   a human's moves every tick; the paddle lurched between parking spots and
   met the ball dead still, unable to hit with any pace at all.

   Perception delay and commitment length are separate here because they are
   separate in a person: how late your eyes are has nothing to do with how
   often your hand changes course.

   Two things are known exactly and continuously, because proprioception is
   not perception: where our own paddle is, and how our own spring behaves.
   ========================================================================== */
const AI = {
  on: false,
  reaction: 0.18,     // s — how stale our view of the BALL is. Nothing else.
  commit:   0.20,     // s — how long a stroke runs before it is reconsidered
  accuracy: 0.85,     // 0..1 — 1 aims exactly, 0 is hopeless
  switchTime: 0.35,   // s — deliberation before committing to the other paddle
};

const AI_LEVELS = {
  easy:   { reaction: 0.34, commit: 0.30, accuracy: 0.55, switchTime: 0.70 },
  normal: { reaction: 0.18, commit: 0.20, accuracy: 0.85, switchTime: 0.35 },
  hard:   { reaction: 0.09, commit: 0.12, accuracy: 0.97, switchTime: 0.16 },
};

const AI_HIST = 256;          // ticks of ball history, for delayed perception
const AI_PRED_DT = 1 / 120;   // coarser than the sim: prediction is cheap, and
                              // half a tick of error is far below the aim error
const AI_PRED_MAX = 4.0;      // s to look ahead before giving up
const AI_FOLLOW_T = 0.12;     // s of follow-through after contact
const AI_FOLLOW_D = 0.70;     // m the target carries on past the contact point
const AI_SWEEP    = 0.45;     // rad the face keeps turning through the ball

const KIND = { TRACK: 0, APPROACH: 1, STRIKE: 2, RECOVER: 3 };

/* One plan. Reused rather than reallocated, so planning at 5 Hz costs nothing
   in garbage. a -> b is the first segment, b -> c the follow-through. */
const plan = {
  kind: KIND.TRACK, dur: 0.2, hitT: 0,
  ax: 0, ay: 0, aa: 0,          // start pose: where the paddle actually was
  bx: 0, by: 0, ba: 0,          // contact pose, or simply the end
  cx: 0, cy: 0, ca: 0,          // follow-through pose
  v1x: 0, v1y: 0, w1: 0,        // velocities, precomputed once per plan
  v2x: 0, v2y: 0, w2: 0,
};

const ai = {
  side: -1,
  hist: null, head: 0, filled: 0,
  world: null,          // scratch world for prediction
  clock: 0,             // seconds elapsed inside the current plan
  has: false,
  sel: 0, wantSel: 0, selHeld: 0,
};

function aiInit(side) {
  ai.side = side;
  ai.head = 0; ai.filled = 0;
  ai.clock = 0; ai.has = false;
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
  AI.commit = L.commit;
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
   those matters depends on geometry the solver cannot see. */
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

// Does a shot pass over the net rather than into it?
function aiClearsNet(px, py, theta, s, g, dx) {
  const dxn = A.width / 2 - px;
  if (dxn * dx <= 0 || Math.abs(dxn) > Math.abs(dx)) return true;   // not in the way
  const X = Math.abs(dxn), c = Math.cos(theta);
  if (Math.abs(c) < 1e-6) return true;                              // straight up
  const y = py + X * Math.tan(theta) - g * X * X / (2 * s * s * c * c);
  return y > A.netHeight + PHYS.ballR * 1.5;
}

/* The paddle angle that turns an incoming velocity into a desired outgoing
   direction. A bounce mirrors the velocity about the surface normal, so the
   normal bisects the reversed incoming direction and the outgoing one. */
function aiPaddleAngleFor(vinx, viny, dirx, diry) {
  const vl = Math.hypot(vinx, viny);
  let nx, ny;
  if (vl < 0.05) { nx = dirx; ny = diry; }         // a still ball: just face it
  else { nx = dirx - vinx / vl; ny = diry - viny / vl; }
  const nl = Math.hypot(nx, ny);
  if (nl < 1e-6) return null;
  return Math.atan2(-nx / nl, ny / nl);
}

/* atan2 answers in (-pi, pi]; the paddle's angle is unbounded, because
   wrapping it is what once sent a peer a target a full turn from its pose.
   Choosing the nearest equivalent HERE is a different act: it picks which of
   the infinitely many equal angles to aim at, before anything is sent. */
function aiNearAngle(target, current) {
  return target + Math.PI * 2 * Math.round((current - target) / (Math.PI * 2));
}

/* Square to the ball: the face normal points straight at it, so the paddle
   presents its whole width to whatever arrives rather than a glancing edge.
   This is the resting posture between shots — you do not stand side-on to a
   ball you might have to reach. */
function aiFaceBall(px, py, bx, by, curA) {
  const nx = bx - px, ny = by - py;
  const nl = Math.hypot(nx, ny);
  if (nl < 1e-6) return curA;
  return aiNearAngle(Math.atan2(-nx / nl, ny / nl), curA);
}

/* Roughly how fast a paddle travels once it is up to speed, and how far behind
   its target it rides while doing so. Both come from the tuning rather than
   being measured, so they stay honest when the feel is retuned. */
function aiPaddleTopSpeed() {
  const w = 2 * Math.PI * FEEL.posFreq;
  const maxE = Math.min(FEEL.maxError, FEEL.reach);
  return Math.max(0.5, w * maxE / (2 * FEEL.posDamp));
}
const aiPosLag = () => 2 * FEEL.posDamp / (2 * Math.PI * FEEL.posFreq);
const aiAngLag = () => 2 * FEEL.angDamp / (2 * Math.PI * FEEL.angFreq);

// Can either of this side's paddles be there in time?
function aiCanReach(w, side, hit) {
  const v = aiPaddleTopSpeed();
  let near = Infinity;
  for (let i = 0; i < (MATCH.paddles > 1 ? 2 : 1); i++) {
    const p = w.p[idOf(side, i)];
    near = Math.min(near, Math.hypot(hit.x - p.x, hit.y - p.y));
  }
  return near / v + 0.12 <= hit.t;      // the constant is the spring's ramp-up
}

/* Run the real physics forward from the PERCEIVED ball state until it arrives
   somewhere one of our paddles could meet it. Paddles are excluded, so this
   answers "where would the ball go if nobody touched it". */
function aiPredict(w, side) {
  const src = aiPerceived(FIXED_DT);
  const pw = ai.world;
  copyWorld(pw, w);
  const b = pw.ball;
  b.x = src.x; b.y = src.y; b.vx = src.vx; b.vy = src.vy; b.w = src.w;
  b.px = b.x; b.py = b.y;

  /* COURT ONLY. paddleBoxes also returns the goal pocket, and including it
     would have the AI aim at intercepts inside its own net, then park on the
     boundary between two boxes that do not touch. */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < (MATCH.paddles > 1 ? 2 : 1); i++) {
    const bx = paddleBoxes(w.p[idOf(side, i)])[0];
    lo = Math.min(lo, bx.x0); hi = Math.max(hi, bx.x1);
  }

  /* The ball is in reach for a stretch of its crossing, not an instant. Taking
     the earliest point means committing to an intercept the paddle cannot
     make. Take the first it can actually be at, and fall back to the earliest
     only when none is reachable - arriving late still beats not going. */
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

/* Where to send the ball from the intercept, and the face angle that does it.
   Returns a unit direction plus the paddle angle, already chosen as the
   representative nearest the paddle's current angle. */
function aiShot(hit, side, curA, errAim, errAng) {
  const goalX = side < 0 ? A.width : 0;
  const goalMid = (goalY0() + goalY1()) / 2;
  const spread = (goalY1() - goalY0()) * 0.5 + 1.5;
  const aimY = goalMid + errAim * spread;

  /* An estimate of how fast the ball will leave, not a speed we can pick - the
     AI only chooses where the face points. The floor is the speed that carries
     half the court at 45 degrees, so a slow ball is still aimed at the goal
     rather than at an impossible solution. */
  const floor = Math.sqrt(Math.max(1, A.width * 0.5 * PHYS.gravity));
  const speed = Math.max(floor, Math.hypot(hit.vx, hit.vy) * 1.15);
  const shot = aiLaunchAngle(hit.x, hit.y, goalX, aimY, speed, PHYS.gravity);

  let dirx, diry;
  if (shot) {
    let theta = shot.low;                          // flat if it clears the net,
    if (!aiClearsNet(hit.x, hit.y, theta, speed, PHYS.gravity, goalX - hit.x))
      theta = shot.high;                           // lofted if it does not
    dirx = shot.sign * Math.cos(theta);
    diry = Math.sin(theta);
  } else {
    // Out of range: send it as far as it will go. 45 degrees is the
    // maximum-range launch, and clears the net comfortably.
    dirx = (side < 0 ? 1 : -1) * Math.SQRT1_2;
    diry = Math.SQRT1_2;
  }

  let a = aiPaddleAngleFor(hit.vx, hit.vy, dirx, diry);
  if (a === null) a = 0;
  return { dirx, diry, a: aiNearAngle(a + errAng, curA) };
}

/* Build the stroke for the next stretch of time. Every path starts at the
   paddle's LIVE pose - never at where the last plan assumed it would end up,
   or the staircase reappears at plan boundaries. */
function aiMakePlan(w, side) {
  const p = w.p[idOf(side, ai.sel)];
  const box = paddleBoxes(p)[0];
  const err = 1 - AI.accuracy;
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;


  // Sampled ONCE per plan, so error is a decision about this shot rather than
  // noise re-rolled underneath the paddle every tick.
  const errAim = (Math.random() * 2 - 1) * err;
  const errAng = (Math.random() * 2 - 1) * 0.5 * err;
  const errOff = (Math.random() * 2 - 1) * 0.5 * err;

  plan.ax = p.x; plan.ay = p.y; plan.aa = p.a;
  const seen = aiPerceived(FIXED_DT);

  /* Which side of the ball are we on? A paddle between the ball and the goal
     it is attacking cannot do anything useful with it: hitting it at all sends
     it the wrong way, toward our own goal. Getting back behind it is a basic
     move of this game and the AI had no concept of it — it would sit in front
     of the ball and swat it homeward, over and over.

     `side` is also the direction toward our own goal, so -side * (p.x - ball.x)
     being positive means we are past the ball on the attacking side. The 0.10
     keeps it from chattering at the boundary; recovery overshoots well past
     that, so it cannot oscillate. */
  const inFront = -side * (p.x - seen.x) > 0.10;

  // No point predicting an intercept we are not allowed to take.
  const hit = inFront ? null : aiPredict(w, side);

  if (inFront) {
    /* Round the ball, not through it. Rise or dive clear first, then run back
       past it at that height — a straight line to the far side would go
       through the ball and hit it exactly the wrong way. Go whichever way has
       more room, so we do not climb into the ceiling. */
    const clear = PHYS.ballR + A.paddleLength * 0.5 + 0.25;
    const gap   = PHYS.ballR + A.paddleLength * 0.5 + 0.30;
    const up = box.y1 - seen.y, down = seen.y - box.y0;
    const clearY = clamp(seen.y + (up >= down ? clear : -clear), box.y0, box.y1);

    plan.kind = KIND.RECOVER;
    plan.dur = AI.commit;
    plan.hitT = plan.dur * 0.45;              // rise, then run
    plan.bx = clamp(p.x, box.x0, box.x1);
    plan.by = clearY;
    plan.cx = clamp(seen.x + side * gap, box.x0, box.x1);
    plan.cy = clearY;
    plan.ba = aiFaceBall(plan.bx, plan.by, seen.x, seen.y, p.a);
    plan.ca = aiFaceBall(plan.cx, plan.cy, seen.x, seen.y, plan.ba);

  } else if (!hit) {
    /* Idle is a path like everything else, so there is no second mechanism to
       flicker against. Track the ball's height and drift toward the middle of
       the zone: what a player does with nothing to hit. */
    plan.kind = KIND.TRACK;
    plan.dur = AI.commit;
    plan.bx = (box.x0 + box.x1) / 2;
    plan.by = clamp(seen.y, box.y0, box.y1);
    plan.ba = aiFaceBall(plan.bx, plan.by, seen.x, seen.y, p.a);
    plan.hitT = plan.dur;

  } else {
    const shot = aiShot(hit, side, p.a, errAim, errAng);

    if (hit.t > AI.commit * 1.6) {
      /* Too far off to swing at. Set up BEHIND the contact point, so when the
         strike comes there is room to accelerate through the ball instead of
         starting from a standstill on top of it. */
      plan.kind = KIND.APPROACH;
      plan.dur = AI.commit;
      plan.bx = clamp(hit.x - shot.dirx * 0.5, box.x0, box.x1);
      plan.by = clamp(hit.y - shot.diry * 0.5, box.y0, box.y1);
      plan.ba = plan.aa + (shot.a - plan.aa) * 0.5;   // rotate part of the way
      plan.hitT = plan.dur;

    } else {
      plan.kind = KIND.STRIKE;
      plan.hitT = Math.max(0.03, hit.t);
      plan.dur = plan.hitT + AI_FOLLOW_T;
      plan.bx = clamp(hit.x, box.x0, box.x1);
      plan.by = clamp(hit.y + errOff, box.y0, box.y1);
      plan.ba = shot.a;
      /* Carry on THROUGH the contact rather than stopping on it. At the moment
         the ball arrives the paddle is still being pulled forward, so it hits
         moving - and the face is still turning, which is what puts spin on it. */
      plan.cx = clamp(plan.bx + shot.dirx * AI_FOLLOW_D, box.x0, box.x1);
      plan.cy = clamp(plan.by + shot.diry * AI_FOLLOW_D, box.y0, box.y1);
      plan.ca = plan.ba + Math.sign(plan.ba - plan.aa || 1) * AI_SWEEP;
    }
  }

  if (plan.kind === KIND.TRACK || plan.kind === KIND.APPROACH) {
    plan.cx = plan.bx; plan.cy = plan.by; plan.ca = plan.ba;
  }

  const t1 = Math.max(1e-3, plan.hitT);
  plan.v1x = (plan.bx - plan.ax) / t1;
  plan.v1y = (plan.by - plan.ay) / t1;
  plan.w1  = (plan.ba - plan.aa) / t1;
  const t2 = Math.max(1e-3, plan.dur - plan.hitT);
  plan.v2x = (plan.cx - plan.bx) / t2;
  plan.v2y = (plan.cy - plan.by) / t2;
  plan.w2  = (plan.ca - plan.ba) / t2;

  // Two-paddle: which zone the ball is arriving in. Inherits the paths untuned.
  if (MATCH.paddles > 1) {
    const boxA = paddleBoxes(w.p[idOf(side, 0)])[0];
    ai.wantSel = hit && hit.x >= boxA.x0 && hit.x <= boxA.x1 ? 0 : 1;
  } else {
    ai.wantSel = 0;
  }
  ai.has = true;
}

/* Called by the server each tick, in place of reading a network input. No
   decisions here - evaluate the stroke and move the hand. */
function aiFillInput(w, side, dst, dt) {
  if (!ai.hist) aiInit(side);
  aiSample(w);

  ai.clock += dt;
  if (!ai.has || ai.clock >= plan.dur) { aiMakePlan(w, side); ai.clock = 0; }

  const s = ai.clock;
  let px, py, pa, vx, vy, vw;
  /* Segment two, for any plan that has one. TRACK and APPROACH set c = b and
     hitT = dur, so they simply never get here. */
  if (s >= plan.hitT) {
    const u = Math.min(s - plan.hitT, plan.dur - plan.hitT);
    px = plan.bx + plan.v2x * u; py = plan.by + plan.v2y * u; pa = plan.ba + plan.w2 * u;
    vx = plan.v2x; vy = plan.v2y; vw = plan.w2;
  } else {
    const u = Math.min(s, plan.hitT);
    px = plan.ax + plan.v1x * u; py = plan.ay + plan.v1y * u; pa = plan.aa + plan.w1 * u;
    vx = plan.v1x; vy = plan.v1y; vw = plan.w1;
  }

  // The spring rides behind a moving target by a fixed slice of time, so aim
  // that far ahead of where the paddle is wanted - as a person compensates for
  // their own hand rather than for the mouse.
  let tx = px + vx * aiPosLag();
  let ty = py + vy * aiPosLag();
  let ta = pa + vw * aiAngLag();

  /* EFFICIENCY, not saturation. stepPaddle clamps position error to maxError,
     so the pull is already at its limit there - holding the target further out
     buys nothing and costs precision on arrival. This is the difference
     between flinging the mouse across the desk and moving it exactly as far as
     it needs to go. The angle spring has no such clamp, so it is left alone. */
  const p = w.p[idOf(side, ai.sel)];
  const maxE = Math.min(FEEL.maxError, FEEL.reach);
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
  if (d > maxE) { const k = maxE / d; tx = p.x + dx * k; ty = p.y + dy * k; }

  if (MATCH.paddles > 1) {
    if (ai.wantSel !== ai.sel) {
      ai.selHeld += dt;
      if (ai.selHeld >= AI.switchTime) { ai.sel = ai.wantSel; ai.selHeld = 0; }
    } else ai.selHeld = 0;
  } else ai.sel = 0;

  // One non-finite number would hand the spring an impossible target.
  if (!isFinite(tx) || !isFinite(ty) || !isFinite(ta)) { tx = p.x; ty = p.y; ta = p.a; }

  dst.sel = ai.sel;
  dst.tx = tx; dst.ty = ty; dst.ta = ta;
}
