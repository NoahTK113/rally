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
};

function aiInit() {
  ai.head = 0;
  ai.filled = 0;
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

/* The ideal defensive position: the midpoint of the line from the ball to the
   centre of our own goal mouth.

   Standing on that line is what blocking means — anything travelling from the
   ball to the goal has to pass through it — and the midpoint is the point on
   it that stays useful as the ball moves, rather than committing to either
   crowding the ball or sitting on the line.

   Computed from the PERCEIVED ball, like everything the AI believes about the
   world. Using the true ball here would give it a blocking position better
   than its own eyes.

   Not clamped to the box: this is where the AI would ideally stand, which is
   not always somewhere it may legally be. Whether it can get there, and
   whether it should try, are separate questions. */
function aiDefensivePosition(aiSide) {
  const arena = aiCfg().arena;
  const ball = aiPerceived().ball;
  const goalX = aiSide < 0 ? 0 : arena.width;
  const goalY = (arena.goalLip + arena.goalLip + arena.goalHeight) / 2;
  return { x: (ball.x + goalX) / 2, y: (ball.y + goalY) / 2 };
}

/* ==========================================================================
   PER TICK

   Observe, and stop. There is no decision layer yet, so the opponent's
   setpoint is left exactly as it was — which is what an unheld paddle already
   receives, so it simply holds its place. Nothing here writes to `dst`.
   ========================================================================== */
function aiStep(w, side, dst, dt) {
  aiObserve(w);
}
