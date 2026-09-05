/* Classic script, not a module — see tutorial.js for why.

   ==========================================================================
   AI — TIER 0: PERCEPTION AND CONFIGURATION

   This file currently decides NOTHING. It establishes the channels the
   opponent receives information through, and nothing else. Behaviour is a
   later layer that reads from here.

   Three channels, and they differ in ways that matter:

     PERCEPTION   everything outside us — the ball and both players' paddles —
                  recorded every tick and read back `reaction` seconds stale.
                  One uniform rule, no per-item exceptions: a person cannot
                  see an opponent's hand any sooner than they can see the ball.

     PROPRIOCEPTION  our own paddles, exact and current. Knowing where your own
                  hand is, is not perception and carries no delay.

     CONFIGURATION  the arena, the physics, our own spring response. It looks
                  constant and is not: a slider can move mid-match. So it is
                  READ, never captured — see aiCfg below.

   Match state — phase, timers, score — is deliberately outside perception. It
   is not something you see across the court and mistime; it is announced.
   ========================================================================== */

const AI = {
  on: false,
  reaction: 0.12,     // s — how stale our view of the OUTSIDE WORLD is

  /* The hand. Not derived from the player's mouse settings on purpose: their
     cursor speed depends on their own sensitivity slider and window size, so
     borrowing it would make the AI's hand change speed whenever the player
     adjusted their mouse. This is the AI's hand, in world units. */
  mouseSpeed: 25,     // m/s — furthest the emitted position may travel per second
  wheelSpeed: 12,     // notches/s — how fast the wheel can be turned

  saveRate: 5,        // m/s — closing on our own goal faster than this is a save
  saveDist: 3.0,      // m — this near the mouth is a save whatever the speed
  strikeDist: 1.75,   // m — inside this, commit and drive through the ball
  strikeAngle: 25,    // deg — how far our approach may sit off the line before
                      //   the strike is abandoned and we get back on it
};

/* Long enough to cover the largest reaction the panel allows (0.6s) at the
   simulation rate, with room to spare. Sized from the constants rather than
   guessed, so a faster tick or a slower slider cannot quietly overrun it. */
const AI_HIST = 256;

/* One observation: the whole world except our own paddles. All four paddles
   are recorded rather than "the opponent's two", so the ring does not care
   which side we are playing — Tab swaps sides mid-match, and a ring that had
   baked in a side would then be holding the wrong paddles. The reader decides
   which of these are theirs; see aiPerceived. */
function makeObservation() {
  const o = { ball: { x: 0, y: 0, vx: 0, vy: 0, w: 0 }, p: {}, sel: { '-1': 0, '1': 0 } };
  for (const id of PIDS) o.p[id] = { x: 0, y: 0, a: 0, vx: 0, vy: 0, w: 0 };
  return o;
}

const ai = {
  hist: null,      // ring of observations
  head: 0,         // next slot to write
  filled: 0,       // how many are valid — matters only for the first moments

  // The hand's own position, carried between ticks. What was last EMITTED,
  // not where the paddle got to.
  outSet: false,
  outX: 0, outY: 0, outA: 0,
  notches: 0,      // fractional wheel allowance carried between ticks

  saving: false,   // latched: see aiUpdateSave
  lined: true,     // latched: are we square enough behind the ball to strike?
};

function aiInit() {
  ai.head = 0;
  ai.filled = 0;
  ai.outSet = false;
  ai.outX = ai.outY = ai.outA = 0;
  ai.notches = 0;
  ai.saving = false;
  ai.lined = true;
  if (!ai.hist) {
    ai.hist = new Array(AI_HIST);
    for (let i = 0; i < AI_HIST; i++) ai.hist[i] = makeObservation();
  }
}

/* Registered rather than called from startGame: this state belongs to the AI,
   so the knowledge that it needs clearing belongs here too. Without it the
   opponent would open each match still holding the previous one's view. */
onNewGame(aiInit);

/* ==========================================================================
   CONFIGURATION

   Every one of these is a function, and that is the whole point. The tuning
   panel writes straight into A, FEEL and PHYS while a match is running, so a
   value captured once — at match start, at plan time, anywhere — silently
   stops matching the game it describes. Nothing here may become a stored
   number. If a caller finds itself holding one of these, it has a bug.

   Returned objects are LIVE REFERENCES, not copies, for the same reason.
   ========================================================================== */
function aiCfg() {
  return {
    arena: A,        // width, height, net, goals, paddle size, zone fractions
    feel: FEEL,      // our own spring: frequencies, damping, error clamp, reach
    phys: PHYS,      // gravity, restitution, friction, ball radius
    match: MATCH,    // points to win, paddles per side
    dt: FIXED_DT,    // the tick the simulation actually advances by
  };
}

/* ==========================================================================
   PERCEPTION
   ========================================================================== */

// Every tick: record the true state of everything outside us.
function aiObserve(w) {
  const o = ai.hist[ai.head];
  const b = w.ball;
  o.ball.x = b.x; o.ball.y = b.y; o.ball.vx = b.vx; o.ball.vy = b.vy; o.ball.w = b.w;
  for (const id of PIDS) {
    const src = w.p[id], rec = o.p[id];
    rec.x = src.x; rec.y = src.y; rec.a = src.a;
    rec.vx = src.vx; rec.vy = src.vy; rec.w = src.w;
  }
  o.sel['-1'] = w.sel['-1'];
  o.sel['1'] = w.sel['1'];

  ai.head = (ai.head + 1) % AI_HIST;
  if (ai.filled < AI_HIST) ai.filled++;
}

/* The world as it looked `reaction` seconds ago.

   Perception is DELAYED, not degraded. The values are exact; they are simply
   old. That is the honest model of a person's limit — they are not seeing a
   blurred ball, they are seeing precisely where it was a moment ago.

   Reads the tick length from configuration rather than assuming one, so
   changing the simulation rate does not silently change the reaction time. */
function aiPerceived() {
  if (!ai.hist) aiInit();
  const dt = aiCfg().dt;
  const want = Math.round(AI.reaction / dt);
  const back = Math.min(Math.max(want, 0), Math.max(0, ai.filled - 1));
  return ai.hist[((ai.head - 1 - back) % AI_HIST + AI_HIST) % AI_HIST];
}

/* Our own paddles, undelayed, straight from the live world. Separate function
   from aiPerceived so the distinction is impossible to blur at a call site:
   if it came from here it is current, if it came from there it is stale. */
function aiSelf(w, side) {
  return { p0: w.p[idOf(side, 0)], p1: w.p[idOf(side, 1)], sel: w.sel[String(side)] | 0 };
}

/* The PLAYER's paddles, as perceived — same delay as the ball.

   Named for who they belong to rather than for their relationship to us.
   "opponent" is relative: from here it means the player, from the player's
   seat it means this AI, and a reader has to hold a perspective in their head
   to know which. "player" means the same thing from either chair.

   The argument is the AI's OWN side, because that is the fact the caller
   reliably knows about itself. */
function aiPlayerPaddles(aiSide) {
  const o = aiPerceived();
  const ps = -aiSide;
  return { p0: o.p[idOf(ps, 0)], p1: o.p[idOf(ps, 1)], sel: o.sel[String(ps)] | 0 };
}

/* Where one of our paddles is allowed to be, right now.

   Taken from the game's own paddleBoxes rather than re-deriving the zone
   maths here. The same numbers computed in two places drift apart the moment
   the zone rules change, and the AI would then be aiming at ground the clamp
   will not let it reach — which is how the previous one ended up fighting the
   boundary it could not see.

   Index [0] is the court box. paddleBoxes also offers a second, disjoint box
   for the goal pocket; we ignore it. There is nothing the AI wants inside its
   own net, and a legal region in two pieces with a gap between them is a
   source of trouble out of all proportion to its use.

   NOT constant. The box shrinks by the paddle's rotated footprint, so it
   changes as the paddle turns and as paddleLength or paddleT are retuned —
   which is why this is a call, not a value. */
function aiBox(p) {
  return paddleBoxes(p)[0];
}

/* The line the player cannot reach past — the x at which their paddle's
   leading edge stops, on our side of the net.

   Rotation-independent, which the box maths disguises. paddleBoxes insets the
   limit by the rotated half-extent (`fx0 = reachAcross + hx`), so the box edge
   moves as the paddle turns — but that limit applies to the paddle's CENTRE,
   and the body reaches hx beyond it. The extremity therefore lands on
   reachAcross at any angle. The inset exists to make that true.

   Only offence may cross the net, and a solo paddle inherits the same reach,
   so this one line binds in either paddle mode.

   All the AI needs to know about where the player can be. Their full box would
   need their paddle's identity and angle, and the perception ring carries
   neither. */
function aiPlayerReach(aiSide) {
  const arena = aiCfg().arena;
  const mid = arena.width / 2;
  return mid - (-aiSide) * mid * arena.crossFrac;
}

/* ==========================================================================
   TIER 1 — DERIVED FROM PERCEPTION

   Facts about the situation, computed from what we can see. Nothing here
   simulates anything forward; every value is arithmetic on the present.
   ========================================================================== */

// The held paddle. Ours, so exact and current.
function aiPaddle(w, side) {
  const self = aiSelf(w, side);
  return self.sel ? self.p1 : self.p0;
}

/* The nearest point on our own goal mouth to the ball. The mouth is a vertical
   segment, so that is the ball's height clamped between the lip and the
   crossbar: the top corner when the ball is above, the bottom corner when it
   is below, and straight along x in between.

   One definition, used by everything downstream. It was written out three
   separate times before this and the copies would have drifted the first time
   the goal geometry changed. */
function aiGoalPoint(aiSide) {
  const arena = aiCfg().arena;
  const ball = aiPerceived().ball;
  const lo = arena.goalLip, hi = arena.goalLip + arena.goalHeight;
  return { x: aiSide < 0 ? 0 : arena.width,
           y: ball.y < lo ? lo : ball.y > hi ? hi : ball.y };
}

/* THE DEFENSIVE LINE runs from that point to the ball. Everything about
   defending is expressed against it: where to stand, how fast the danger is
   growing, and how far out of position we are. */

/* The ideal defensive position: the midpoint of the line.

   Standing on the line is what blocking means — anything travelling from the
   ball to the goal has to cross it — and the midpoint is the point on it that
   stays useful as the ball moves, rather than committing to crowding the ball
   or sitting on the goal.

   Not clamped to the box: this is where the AI would ideally stand, which is
   not always somewhere it may legally be. */
function aiDefensivePosition(aiSide) {
  const ball = aiPerceived().ball;
  const g = aiGoalPoint(aiSide);
  return { x: (ball.x + g.x) / 2, y: (ball.y + g.y) / 2 };
}

// How long the line is: the ball's distance from our goal mouth.
function aiBallGoalDistance(aiSide) {
  const ball = aiPerceived().ball;
  const g = aiGoalPoint(aiSide);
  return Math.hypot(g.x - ball.x, g.y - ball.y);
}

/* How fast the line is shrinking — the ball's velocity projected along it.
   Positive approaching, negative opening.

   Taken from the velocity the observation already carries rather than by
   differencing positions, which would only add noise to a number we have
   exactly.

   While the ball is level with the mouth the line is horizontal, so vertical
   motion contributes nothing. A ball flying straight up across the face of the
   goal closes at zero, which is right: it is getting no nearer. */
function aiClosingRate(aiSide) {
  const ball = aiPerceived().ball;
  const g = aiGoalPoint(aiSide);
  const dx = g.x - ball.x, dy = g.y - ball.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return 0;
  return (ball.vx * dx + ball.vy * dy) / l;
}

// Our paddle's distance from the ball.
function aiBallDistance(w, side) {
  const p = aiPaddle(w, side), ball = aiPerceived().ball;
  return Math.hypot(ball.x - p.x, ball.y - p.y);
}

/* The point on the line closest to us, clamped to the segment. Beyond the ball
   that is the ball itself; behind the goal point it is the goal point. */
function aiNearestOnLine(w, side) {
  const p = aiPaddle(w, side), ball = aiPerceived().ball;
  const g = aiGoalPoint(side);
  const lx = ball.x - g.x, ly = ball.y - g.y;
  const ll = lx * lx + ly * ly;
  if (ll < 1e-12) return { x: g.x, y: g.y };
  let t = ((p.x - g.x) * lx + (p.y - g.y) * ly) / ll;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: g.x + lx * t, y: g.y + ly * t };
}

/* How far our approach sits off the defensive line, in DEGREES: the angle
   between the direction we would drive (paddle to ball) and the direction the
   ball should leave in (goal to ball, extended).

   Degrees rather than the perpendicular offset over range we first reached
   for. That ratio is sin of this angle, and sine FOLDS BACK past ninety
   degrees — a paddle a hundred and seventy degrees off, sitting almost
   directly beyond the ball and about to knock it homeward, scores 0.17 on it,
   better than a harmless twenty. The cosine behind this is monotonic all the
   way to a hundred and eighty, so being on the wrong side of the ball reads as
   what it is: the worst case, not a good one.

   Which is the failure this exists to catch. Contact sends the ball roughly
   along paddle-to-ball extended, so this angle is very nearly the angle the
   ball leaves at, measured from straight out of our own goal. */
function aiStrikeOffAngle(w, side) {
  const p = aiPaddle(w, side), ball = aiPerceived().ball, g = aiGoalPoint(side);
  const ux = ball.x - g.x, uy = ball.y - g.y;      // where the ball should go
  const ax = ball.x - p.x, ay = ball.y - p.y;      // where we would send it
  const ul = Math.hypot(ux, uy), al = Math.hypot(ax, ay);
  if (ul < 1e-6 || al < 1e-6) return 0;
  let c = (ux * ax + uy * ay) / (ul * al);
  c = c < -1 ? -1 : c > 1 ? 1 : c;
  return Math.acos(c) * 180 / Math.PI;
}

/* The angle that points the paddle's FACE at the ball.

   collidePaddle puts the paddle's spine along its local x, so for angle a the
   spine runs along (cos a, sin a) and the face normal is perpendicular to it,
   (-sin a, cos a). Wanting that normal to point along a unit vector (nx, ny)
   therefore means -sin a = nx and cos a = ny, which is atan2(-nx, ny).

   Facing the ball squarely presents the paddle's full width to it rather than
   an edge it can slide past. Measured from our own paddle, which we know
   exactly, to the PERCEIVED ball, which we do not. */
function aiFaceBall(w, side) {
  const p = aiPaddle(w, side);
  const b = aiPerceived().ball;
  const nx = b.x - p.x, ny = b.y - p.y;
  const l = Math.hypot(nx, ny);
  if (l < 1e-6) return null;        // sitting on the ball: no opinion to have
  return Math.atan2(-nx / l, ny / l);
}

/* ==========================================================================
   OUTPUT — THE HAND

   A decision says where it wants the paddle; this says what a hand can
   actually do about it. Both limits act on what is EMITTED, not on where the
   paddle ends up, because the paddle is the spring's business and the hand
   only holds the mouse.

   The two need different treatment for a reason in stepPaddle. Position error
   is clamped to maxError before the spring sees it, so a target fifty metres
   away pulls exactly as hard as one at the clamp — acceleration saturates and
   there is a terminal speed whatever we emit. Rotation has no such clamp:
   torque is proportional to the whole angular error, so a distant target spins
   the paddle arbitrarily fast. Nothing downstream will stop that. Any limit on
   rotation has to be here.
   ========================================================================== */

/* What an unconstrained position would really buy is not speed — the clamp
   already caps that — but the ability to REVERSE instantly at full force,
   which no hand can do. That is what this removes. */
function aiMoveToward(wantX, wantY, dt) {
  const lim = AI.mouseSpeed * dt;
  let dx = wantX - ai.outX, dy = wantY - ai.outY;
  const d = Math.hypot(dx, dy);
  if (d > lim && d > 0) { const k = lim / d; dx *= k; dy *= k; }
  ai.outX += dx;
  ai.outY += dy;
}

/* The wheel, in notches. The grid snap is copied from the player's own wheel
   handler rather than approximated — same rounding, same one-notch advance —
   so the AI can only ever rest on an angle a player could also have reached.
   Coarse while far, fine for the last stretch, which is the choice a player
   makes without thinking about it.

   The carry is capped so a still period cannot bank notches and spend them as
   a burst, which would reproduce the unbounded spin in a subtler form. */
function aiWheelToward(wantA, dt) {
  if (wantA === null) return;     // no opinion about the angle: leave it alone
  ai.notches = Math.min(ai.notches + AI.wheelSpeed * dt, 2);
  const budget = Math.floor(ai.notches);
  if (budget < 1) return;

  /* Take the short way round. The wheel's angle accumulates without bound,
     exactly as a player's does, while a decision naturally hands us something
     from atan2 in (-pi, pi]. Turning to the literal number would mean winding
     a full turn to reach an angle already underfoot.

     This belongs to the HAND, not to whoever decided: it is the wheel that
     knows where it currently sits, and putting it here means no future
     decision can get it wrong. A whole turn is 12 coarse notches or 48 fine
     ones, so shifting by one leaves the grid alignment untouched. */
  const TAU = Math.PI * 2;
  const target = wantA + TAU * Math.round((ai.outA - wantA) / TAU);

  const err = target - ai.outA;
  const step = Math.abs(err) >= STEP_COARSE ? STEP_COARSE : STEP_FINE;
  const n = Math.round(err / step);
  if (n === 0) return;

  const use = Math.min(budget, Math.abs(n));
  ai.notches -= use;
  ai.outA = (Math.round(ai.outA / step) + Math.sign(n) * use) * step;
}

/* Writes the setpoint. Seeded from the paddle's live pose the first time, or
   the hand would start at the origin and drag the paddle across the court.

   `sel` is left alone: choosing which paddle to hold is a decision, not
   something a hand does, and there is nothing making that decision yet. */
function aiEmit(w, side, dst, want, dt) {
  const self = aiSelf(w, side);
  const p = self.sel ? self.p1 : self.p0;
  if (!ai.outSet) {
    ai.outX = p.x; ai.outY = p.y; ai.outA = p.a;
    ai.outSet = true;
  }
  aiMoveToward(want.x, want.y, dt);
  aiWheelToward(want.a, dt);
  dst.tx = ai.outX; dst.ty = ai.outY; dst.ta = ai.outA;
}

/* ==========================================================================
   DECISION

   Returns what the AI WANTS: a position, and an angle or null for "no opinion
   about the angle". What a hand can do about that want is aiEmit's business,
   and the two are kept apart deliberately — a decision that also knew about
   hand limits would be tempted to compromise its intent to suit them.

   The default sits at the BOTTOM. A new state is an early return above it,
   which is why there is no scaffolding here for states that do not exist:
   adding one means adding its own condition and its own return, not filling in
   a slot. The default is what happens when nothing else claims the tick, and
   every state that ends falls back to it without having to say so.
   ========================================================================== */
/* Is the ball a threat we have to deal with now?

   Entering takes EITHER alarm; leaving takes BOTH to be clear. That asymmetry
   is the whole hysteresis — no extra thresholds needed. Between "closing at
   saveRate" and "actually receding" lies a wide band in which the state simply
   holds, so a ball that merely slows down does not release it.

   Exit deliberately does not fire on contact. After a good touch the ball
   flies off, the rate goes negative and the distance grows, so the triggers
   release within a tick or two anyway — contact buys nothing there. After a
   BAD touch, one that leaves the ball trickling goalward, contact would say
   "done" while the ball is still going in. It is a proxy for success that is
   wrong in exactly the case that matters.

   A stationary ball in front of the mouth can never satisfy the exit, because
   zero is not less than zero. That is correct: it still has to be dealt with. */
function aiUpdateSave(side) {
  const closing = aiClosingRate(side);
  const dist = aiBallGoalDistance(side);
  if (ai.saving) {
    if (closing < 0 && dist > AI.saveDist) ai.saving = false;
  } else if (closing > AI.saveRate || dist < AI.saveDist) {
    ai.saving = true;
  }
  return ai.saving;
}

/* SAVE. Hold the defensive position until the ball is within reach, then
   drive through it.

   There is no need to advance on the ball before that. The defensive position
   is the midpoint of the ball-to-goal line, so waiting there keeps the paddle
   ON the line the whole time the ball is closing — and the line is where a
   block has to happen. Setting off early would only mean meeting the ball
   further from goal with less certainty about where it is going.

   The strike target sits one maxError PAST the ball, along that same line
   extended away from the goal. One maxError because that is exactly where the
   spring saturates: nearer gives less than full force, further gives no more.
   Full power, least overshoot. The paddle therefore arrives still accelerating
   and drives through the ball rather than settling onto it, and the direction
   sends the ball straight out from our goal.

   Note the target is already ON the line — it is the line, extended — so there
   is no sideways error left to correct while striking. Blending it toward the
   line would only drag it back along the line: at strike range the halfway
   point lands behind the ball, and the paddle would stop short of the thing it
   came to hit. */
function aiSaveTarget(w, side) {
  if (aiBallDistance(w, side) > AI.strikeDist) {
    ai.lined = true;                 // each new strike starts with a clean slate
    return aiDefensivePosition(side);
  }

  /* Guard the strike while it is happening, not only when it begins. Driving
     through the ball from the wrong angle sends it sideways, and from behind it
     sends it at our own goal — worse than not striking at all. If the approach
     drifts too far off, abandon the strike and get back on the line first.

     Latched with room between the thresholds: leaving takes the full angle,
     returning takes well under it. Identical ones would have the paddle
     flicking between striking and repositioning while it sat on the boundary,
     and those two want it in quite different places. */
  const off = aiStrikeOffAngle(w, side);
  if (ai.lined) { if (off > AI.strikeAngle) ai.lined = false; }
  else if (off < AI.strikeAngle * 0.6) ai.lined = true;
  if (!ai.lined) return aiNearestOnLine(w, side);

  const ball = aiPerceived().ball;
  const g = aiGoalPoint(side);
  const ux = ball.x - g.x, uy = ball.y - g.y;
  const l = Math.hypot(ux, uy);
  if (l < 1e-6) return { x: ball.x, y: ball.y };

  const feel = aiCfg().feel;
  const past = Math.min(feel.maxError, feel.reach);
  return { x: ball.x + (ux / l) * past, y: ball.y + (uy / l) * past };
}

function aiDecide(w, side) {
  const face = aiFaceBall(w, side);   // the same in every state

  if (aiUpdateSave(side)) {
    const t = aiSaveTarget(w, side);
    return { x: t.x, y: t.y, a: face };
  }

  // Default: hold the defensive position.
  const d = aiDefensivePosition(side);
  return { x: d.x, y: d.y, a: face };
}

/* ==========================================================================
   PER TICK
   ========================================================================== */
function aiStep(w, side, dst, dt) {
  aiObserve(w);            // always: a ring that only filled while the AI
                           // played would start every match blind
  if (!AI.on) return;      // practice leaves the opposing paddle inert
  aiEmit(w, side, dst, aiDecide(w, side), dt);
}
