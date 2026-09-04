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
  wheelRate: 12,      // wheel clicks per second — the hand's actual limit
  maxCommit: 0.50,    // s — how far ahead a STRIKE is worth predicting at all,
                      //     and the longest a non-recovery plan may run
  standoff: 3.5,      // multiplier on the safe distance. Hovering right on
                      //     the ball is both annoying and easy to hit past
  maxRecover: 2.00,   // s — a recovery may commit for far longer; it is one
                      //     unambiguous movement, and the opponent is unlikely
                      //     to be able to interrupt it
};

const AI_LEVELS = {
  easy:   { reaction: 0.34, commit: 0.30, accuracy: 0.55, switchTime: 0.70, wheelRate: 7,  maxCommit: 0.60, maxRecover: 2.2, standoff: 4.0 },
  normal: { reaction: 0.18, commit: 0.20, accuracy: 0.85, switchTime: 0.35, wheelRate: 12, maxCommit: 0.50, maxRecover: 2.0, standoff: 3.5 },
  hard:   { reaction: 0.09, commit: 0.12, accuracy: 0.97, switchTime: 0.16, wheelRate: 18, maxCommit: 0.38, maxRecover: 1.8, standoff: 3.0 },
};

const AI_HIST = 256;          // ticks of ball history, for delayed perception
const AI_PRED_DT = 1 / 120;   // coarser than the sim: prediction is cheap, and
                              // half a tick of error is far below the aim error
const AI_FOLLOW_T = 0.12;     // s of follow-through after contact
const AI_BACKSWING = 0.18;    // s of run-up before contact, to arrive moving

const KIND = { IDLE: 0, APPROACH: 1, STRIKE: 2, RECOVER: 3, CLEAR: 4 };
const AI_FRONT_M = 0.10;      // m past the ball before we call it wrong-side

/* One plan. Reused rather than reallocated, so planning at 5 Hz costs nothing
   in garbage. a -> b is the first segment, b -> c the follow-through. */
const plan = {
  kind: KIND.IDLE, dur: 0.2, hitT: 0,
  ax: 0, ay: 0, aa: 0,          // start pose: where the paddle actually was
  bx: 0, by: 0, ba: 0,          // contact pose, or simply the end
  cx: 0, cy: 0, ca: 0,          // follow-through pose
  t2: 0,                        // how long segment two WANTS, before any cap
  v1x: 0, v1y: 0, w1: 0,        // velocities, precomputed once per plan
  v2x: 0, v2y: 0, w2: 0,
};

const ai = {
  side: -1,
  hist: null, head: 0, filled: 0,
  world: null,          // scratch world for prediction
  clock: 0,             // seconds elapsed inside the current plan
  has: false,
  recovering: false,    // latched: set when caught in front, cleared only on arrival
  clearing: false,      // latched: no room to stand off, so hit it away instead
  wheel: 0,             // the hand's accumulated angle, exactly like intent.ta
  wheelSet: false,
  clicks: 0,            // fractional wheel budget carried between ticks
  sel: 0, wantSel: 0, selHeld: 0,
};

function aiInit(side) {
  ai.side = side;
  ai.head = 0; ai.filled = 0;
  ai.clock = 0; ai.has = false;
  ai.wheel = 0; ai.wheelSet = false; ai.clicks = 0;
  ai.recovering = false; ai.clearing = false;
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
  AI.wheelRate = L.wheelRate;
  AI.maxCommit = L.maxCommit;
  AI.maxRecover = L.maxRecover;
  AI.standoff = L.standoff;
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
  /* The horizon is the strike commitment, not a fixed constant. There is no
     value in predicting a contact a second out: the AI cannot know what the
     opponent will do, and by then the ball would have been hit, bounced or
     rolled somewhere else. Beyond the horizon there is simply no candidate, so
     the AI holds station rather than standing on a stale guess — and each
     prediction costs a fraction of what it did. */
  const steps = Math.floor(AI.maxCommit / AI_PRED_DT);
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

/* Where to send the ball, the face angle that does it, and HOW HARD TO SWING.

   The contact solver gives, along the normal:

       v_out·n  =  -e·(v_in·n) + (1+e)·(v_p·n)        e = PHYS.paddleRest

   With e at 0.18 a stationary paddle returns under a fifth of what arrives —
   below restThreshold it returns nothing but its own motion. The swing IS the
   shot. This used to model a mirror bouncing a ball off a still paddle, which
   is the opposite of the physics: it could only find a solution when the ball
   already arrived fast, and then fell short anyway, because the speed it
   solved for was never the speed it produced.

   So: point the face at the target, swing along that normal, and pick the
   speed. Ball speed becomes a decision rather than something inherited, which
   is what puts the far goal in range from almost anywhere on the court.

   The approximation: the incoming ball's TANGENTIAL velocity survives the
   contact and skews the result a little. Under a hard swing the normal term
   dominates, so it is a few degrees, well inside the aim error. */
function aiShot(hit, side, curA, errAim, errAng) {
  const goalX = side < 0 ? A.width : 0;
  const goalMid = (goalY0() + goalY1()) / 2;
  const spread = (goalY1() - goalY0()) * 0.5 + 1.5;
  const aimY = goalMid + errAim * spread;

  // The hardest ball this paddle can produce, and therefore the flattest,
  // fastest shot available. Always swing at the maximum.
  const e = PHYS.paddleRest;
  const vpMax = aiPaddleTopSpeed();
  const speed = (1 + e) * vpMax;
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

  /* Face square along the outgoing direction, and swing that way. Solving for
     the paddle speed that yields the wanted ball speed: a ball already moving
     toward the face does part of the work, so v_in·n reduces the swing needed. */
  const vinN = hit.vx * dirx + hit.vy * diry;
  let vp = (speed + e * vinN) / (1 + e);
  if (!(vp > 0)) vp = 0;
  if (vp > vpMax) vp = vpMax;

  const a = Math.atan2(-dirx, diry);          // face normal points along (dirx,diry)
  return { dirx, diry, vp, a: aiNearAngle(a + errAng, curA) };
}

/* Signed distance behind the ball, along the axis of our own goal. `side` is
   also the direction toward that goal, so positive is safely behind and
   negative means caught on the wrong side. */
const aiBehind = (p, seen, side) => side * (p.x - seen.x);

/* How far behind the ball to stand. Far enough that a ball struck now takes
   longer to arrive than we need to see it and start moving — which is why it
   is built from reaction and commit rather than picked out of the air. It
   scales with how fast the ball is actually going, with a floor at the speed
   a shot would need to cross half the court, since a ball sitting still will
   not stay that way.

   A pleasant consequence: a quicker AI stands closer, because it can afford
   to. That falls out of the definition rather than being tuned in per level. */
function aiSafeDist(seen) {
  const nominal = Math.sqrt(Math.max(1, A.width * 0.5 * PHYS.gravity));
  const v = Math.max(nominal, Math.hypot(seen.vx, seen.vy));
  const d = v * (AI.reaction + AI.commit * 0.5) * AI.standoff;
  const min = PHYS.ballR + A.paddleLength * 0.5 + 0.30;   // clear of the ball
  return Math.min(Math.max(d, min), A.width * 0.45);
}

/* A hand cannot dial in an arbitrary angle. The wheel moves in detents and
   only so many per second, and every value it can produce is a multiple of the
   active step. The path asks for a smooth real-valued angle; this turns that
   intent into the discrete, rate-limited stream a wrist can actually make.

   Without it the AI emitted angles no wheel could generate — a strike needing
   a quarter turn inside 30ms works out at some three thousand degrees a
   second, continuously, which is what read as the mouse spinning impossibly.

   The grid-snap is copied deliberately from the wheel handler rather than
   approximated: same rounding, same one-notch advance, so the AI can only ever
   sit on angles a player could also have reached.

   Coarse while far, fine for the last stretch — the choice a player makes
   without thinking about it. */
function aiWheel(desired, dt) {
  ai.clicks = Math.min(ai.clicks + AI.wheelRate * dt, 2);   // no saved-up bursts
  const budget = Math.floor(ai.clicks);
  if (budget < 1) return ai.wheel;

  const err = desired - ai.wheel;
  const step = Math.abs(err) >= STEP_COARSE ? STEP_COARSE : STEP_FINE;
  const notches = Math.round(err / step);
  if (notches === 0) return ai.wheel;

  const use = Math.min(budget, Math.abs(notches));
  ai.clicks -= use;
  ai.wheel = (Math.round(ai.wheel / step) + Math.sign(notches) * use) * step;
  return ai.wheel;
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
  // No point predicting an intercept we are not allowed to take.
  const hit = (ai.recovering || ai.clearing) ? null : aiPredict(w, side);

  if (ai.recovering) {
    /* RECOVER is a GOAL, not a position: get behind the ball. It is latched
       elsewhere and cleared only on arrival, so it cannot be abandoned by a
       boundary test flickering — which is what kept it oscillating while it
       was a mode idle could talk it out of every 200ms.

       And it runs as long as the move takes, not for one commit interval.
       Crossing the court to get behind the ball is not a decision worth
       re-taking five times a second; it is one unambiguous movement. Both
       segments travel at the paddle's top speed, so the duration falls out of
       the distance rather than being chosen.

       Round the ball, not through it: rise or dive clear first, then run back
       past it at that height. A straight line to the far side would go through
       the ball and hit it exactly the wrong way. Go whichever way has more
       room, so we do not climb into the ceiling. */
    const clear = PHYS.ballR + A.paddleLength * 0.5 + 0.25;
    const up = box.y1 - seen.y, down = seen.y - box.y0;
    const clearY = clamp(seen.y + (up >= down ? clear : -clear), box.y0, box.y1);
    const destX = clamp(seen.x + side * aiSafeDist(seen), box.x0, box.x1);
    const top = aiPaddleTopSpeed();

    plan.kind = KIND.RECOVER;
    plan.bx = clamp(p.x, box.x0, box.x1); plan.by = clearY;
    plan.cx = destX;                      plan.cy = clearY;
    plan.hitT = Math.max(0.02, Math.abs(plan.by - p.y) / top);
    plan.t2   = Math.max(0.02, Math.abs(plan.cx - plan.bx) / top);
    plan.dur  = plan.hitT + plan.t2;
    plan.ba = aiFaceBall(plan.bx, plan.by, seen.x, seen.y, p.a);
    plan.ca = aiFaceBall(plan.cx, plan.cy, seen.x, seen.y, plan.ba);

  } else if (ai.clearing) {
    /* CLEAR: drive straight through the ball and get it off our wall. No
       backswing — the room behind us is exactly what is missing — so the run-up
       is whatever distance already separates us from the ball, taken at top
       speed. The face is set 45 degrees upfield, which is the maximum-range
       launch and clears the net, so wherever the ball goes it is away from our
       goal. Being behind the ball is already guaranteed: if we were not, the
       recovery latch would have claimed this tick instead. */
    const dirx = -side * Math.SQRT1_2, diry = Math.SQRT1_2;
    const top = aiPaddleTopSpeed();
    const tx = clamp(seen.x, box.x0, box.x1), ty = clamp(seen.y, box.y0, box.y1);
    let sx = tx - p.x, sy = ty - p.y;
    const sl = Math.max(1e-4, Math.hypot(sx, sy));
    sx /= sl; sy /= sl;

    plan.kind = KIND.CLEAR;
    plan.bx = tx; plan.by = ty;
    plan.cx = clamp(tx + sx * top * AI_FOLLOW_T, box.x0, box.x1);
    plan.cy = clamp(ty + sy * top * AI_FOLLOW_T, box.y0, box.y1);
    plan.hitT = Math.max(0.02, sl / top);
    plan.t2 = AI_FOLLOW_T;
    plan.dur = plan.hitT + plan.t2;
    plan.ba = plan.ca = aiNearAngle(Math.atan2(-dirx, diry), p.a);

  } else if (!hit) {
    /* IDLE is a position to HOLD: the ball's height, a safe distance behind
       it. There is nothing special about the centre of the zone, and aiming
       for it was a bug in its own right — it sits in front of the ball, so it
       fought recovery directly. */
    plan.kind = KIND.IDLE;
    plan.dur = AI.commit;
    plan.hitT = plan.dur;
    plan.t2 = 0;
    plan.bx = clamp(seen.x + side * aiSafeDist(seen), box.x0, box.x1);
    plan.by = clamp(seen.y, box.y0, box.y1);
    plan.ba = aiFaceBall(plan.bx, plan.by, seen.x, seen.y, p.a);
    plan.cx = plan.bx; plan.cy = plan.by; plan.ca = plan.ba;

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
      plan.t2 = 0;
      plan.cx = plan.bx; plan.cy = plan.by; plan.ca = plan.ba;

    } else {
      /* Arrive MOVING. The old path ran from wherever the paddle was to the
         contact point over hitT, so the better positioned it was the SLOWER it
         arrived — a short distance over a fixed time — and the follow-through
         only accelerated after the ball had already gone. It was decoration.

         The two segments are now a backswing and a swing. b sits behind the
         contact along the swing line, and segment two runs from there, through
         the ball, to the follow-through, at one constant speed. Contact happens
         INSIDE that segment, so the paddle is at full swing speed exactly when
         the ball arrives and is still driving through it afterwards. */
      plan.kind = KIND.STRIKE;
      const tau = Math.min(AI_BACKSWING, Math.max(0, hit.t - 0.02));
      const hx = clamp(hit.x, box.x0, box.x1);
      const hy = clamp(hit.y + errOff, box.y0, box.y1);

      plan.bx = clamp(hx - shot.dirx * shot.vp * tau, box.x0, box.x1);
      plan.by = clamp(hy - shot.diry * shot.vp * tau, box.y0, box.y1);

      /* A backswing clipped by a wall is a shorter run-up, and a shorter run-up
         cannot reach the same speed in the same time. Take the speed the
         geometry actually allows rather than asking the target to outrun the
         paddle it is pulling. */
      const runD = Math.hypot(hx - plan.bx, hy - plan.by);
      const vp = tau > 1e-3 ? Math.min(shot.vp, runD / tau) : shot.vp;

      plan.cx = clamp(hx + shot.dirx * vp * AI_FOLLOW_T, box.x0, box.x1);
      plan.cy = clamp(hy + shot.diry * vp * AI_FOLLOW_T, box.y0, box.y1);

      plan.hitT = Math.max(0.02, hit.t - tau);   // reach the backswing by here
      plan.t2   = tau + AI_FOLLOW_T;             // then one sweep through the ball
      plan.dur  = plan.hitT + plan.t2;

      /* Face set before the swing and held through it. Turning during contact
         would move the normal mid-hit, and the wheel could not deliver that
         rotation anyway. */
      plan.ba = shot.a;
      plan.ca = shot.a;
    }
  }

  /* Recovery gets a far longer leash, because it is a different kind of
     decision. Running corner to corner to get behind the ball is one
     unambiguous movement, and while it happens the opponent is unlikely to be
     able to change the situation — so committing two seconds to it is sound,
     where committing two seconds to a STRIKE never is: the opponent would
     simply be standing there when it arrived.

     Whatever the limit, a plan that outruns it is TRUNCATED, not rescaled. The
     paddle stops partway along the same path and the next plan continues from
     there. Recovery keeps its latch across that boundary, so the goal survives
     even though the plan does not — and if the ball does come back, the latch
     ends the recovery early on its own. */
  plan.dur = Math.min(plan.dur,
                      plan.kind === KIND.RECOVER ? AI.maxRecover : AI.maxCommit);

  const t1 = Math.max(1e-3, plan.hitT);
  plan.v1x = (plan.bx - plan.ax) / t1;
  plan.v1y = (plan.by - plan.ay) / t1;
  plan.w1  = (plan.ba - plan.aa) / t1;
  /* From what segment two ASKED for, not from what is left of a capped plan.
     Deriving it from dur would make a truncated path travel the same distance
     in less time, ie faster — the cap must shorten the move, never hurry it. */
  const t2 = Math.max(1e-3, plan.t2);
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

  /* The latch, tested every tick rather than only when a plan expires. Both
     edges have to be immediate: being caught in front must interrupt whatever
     is running, and arriving must end a recovery at once, or a move that takes
     a second and a half would carry on long after it had succeeded.

     The gap between the two thresholds is the whole point. It enters at a tenth
     of a metre past the ball and leaves only at nearly the full safe distance
     behind it — so a paddle sitting near the boundary cannot flip between them,
     which is precisely how the oscillation worked. */
  const mine = w.p[idOf(side, ai.sel)];
  const now = aiPerceived(FIXED_DT);
  const behind = aiBehind(mine, now, side);
  const safe = aiSafeDist(now);
  const depth = side < 0 ? now.x : A.width - now.x;    // ball's distance to OUR wall

  if (ai.recovering) {
    /* The goal has to be REACHABLE or recovery never ends. With the ball near
       our own wall there is not room to get a full safe distance behind it —
       you cannot stand outside the court — so the target is whatever the space
       actually allows. Demanding the full distance would have left the AI
       recovering forever against a ball parked near its goal. */
    const want = Math.min(safe * 0.9, Math.max(0.25, depth - 0.35));
    if (behind >= want) { ai.recovering = false; ai.clock = plan.dur; }
  } else if (behind < -AI_FRONT_M) {
    ai.recovering = true; ai.clock = plan.dur;
  }

  /* No room to stand off: the standoff position would be outside the court, so
     holding station means pinning itself to its own back wall and waiting to be
     squeezed between the wall and the ball. Hit it away instead. Latched, with
     the exit well above the entry, because the two behaviours want opposite
     things — one drives at the ball, the other retreats from it — and a
     boundary they could flip across is exactly how the earlier oscillations
     worked. Clearing is self-resolving anyway: a successful clear moves the
     ball away and the condition stops holding. */
  if (ai.clearing) {
    if (depth > safe * 1.35) ai.clearing = false;
  } else if (depth < safe && !ai.recovering) {
    ai.clearing = true; ai.clock = plan.dur;
  }

  ai.clock += dt;
  if (!ai.has || ai.clock >= plan.dur) { aiMakePlan(w, side); ai.clock = 0; }

  const s = ai.clock;
  let px, py, pa, vx, vy, vw;
  /* Segment two, for any plan that has one. A plan with nothing to do after
     its waypoint sets c = b and hitT = dur, so it never gets here. */
  if (s >= plan.hitT) {
    const u = Math.min(s - plan.hitT, plan.t2);
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

  /* The path's angle is what the AI WANTS; the wheel is what it can actually
     do. The plan's angular rates are advisory from here on — a stroke needing
     a big turn now has to be started early enough for the hand to get there,
     which is exactly why APPROACH pre-rotates half way. */
  if (!ai.wheelSet) { ai.wheel = w.p[idOf(side, ai.sel)].a; ai.wheelSet = true; }
  /* Hands off the wheel while recovering. Facing the ball while ORBITING it at
     close range means the bearing sweeps quickly, so chasing it spent the whole
     click budget on an angle that never settled — and the face does not matter
     until we are back behind the ball. */
  let ta = plan.kind === KIND.RECOVER ? ai.wheel : aiWheel(pa + vw * aiAngLag(), dt);

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
  if (!isFinite(tx) || !isFinite(ty) || !isFinite(ta)) { tx = p.x; ty = p.y; ta = ai.wheel = p.a; }

  dst.sel = ai.sel;
  dst.tx = tx; dst.ty = ty; dst.ta = ta;
}
