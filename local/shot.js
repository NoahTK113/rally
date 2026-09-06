/* Classic script, not a module — see tutorial.js for why.

   ==========================================================================
   SHOT SEARCH

   Given the ball's future, find the best contact to make and what to do at it.

   Separate file on purpose: this is the part most likely to be thrown away and
   rewritten. It reaches into the AI only through the sensory accessors —
   aiPerceived, aiCfg, aiPaddle, aiBox, aiPlayerPaddle — and hands back a plain
   description of a shot. Nothing in ai.js knows how it works, so a different
   search can replace it without touching a single decision.

   THE SHAPE OF THE SEARCH

     1. Simulate the ball forward ONCE, with the real physics. Every point on
        that path is a candidate contact — there is no need to re-simulate the
        approach for each one.

     2. At each candidate, sweep aim points across the goal mouth and a few
        launch speeds, and solve the launch angle for each. Aiming at the mouth
        rather than at its centre matters: the mouth is three metres tall, and
        insisting on the middle throws away most of the solutions and aims
        squarely at where the player is standing.

     3. Test each flight in closed form. There is no Magnus force in this
        simulation — spin is applied at contact and never again — so between
        bounces the trajectory is an EXACT parabola. Evaluating one costs about
        twenty operations, which is why thousands of candidates are affordable.

     4. Reject anything the paddle or the wheel cannot physically do in the time
        available, then score what survives.

   WHAT IT DOES NOT DO

   Direct flight only. A bank shot off a wall or the ceiling is a sequence of
   parabola segments and perfectly solvable, but it is not here yet — this
   version declines those rather than misplaying them.
   ========================================================================== */

const SHOT = {
  horizon: 1.5,       // s of ball future to consider
  sampleDt: 1 / 60,   // s between candidate contacts along that path
  aimPoints: 5,       // how many places across the goal mouth to try
  speedSteps: 3,      // how many launch speeds, from the hardest downward
  slowest: 0.65,      // the slowest of them, as a fraction of the hardest
  ramp: 0.10,         // s of the paddle's spin-up, unavailable for travelling

  // Scoring weights. What makes one shot better than another.
  wSpeed: 1.0,        // faster gives the player less time
  wPass: 1.6,         // passing further from the player matters more
  wMargin: 0.5,       // and some room inside the posts, so it is not a coin flip
  wTime: 0.4,         // sooner is better: less time for the situation to change
};

const SHOT_PRED_DT = 1 / 120;   // integration step for the ball's future

let shotWorld = null;

/* Debug capture. The full sampled trajectory of the last search, and the shot
   it settled on. Only the renderer reads these; nothing decides anything from
   them. */
let shotLastPath = null;
let shotDebug = null;

/* ==========================================================================
   THE BALL'S FUTURE

   The real stepBall, so walls, net, floor, gravity and spin behave exactly as
   they will in the game. Paddles excluded: ours would make it circular, and
   there is no knowing where the player's will be.
   ========================================================================== */
function shotPath(w, aiSide) {
  if (!shotWorld) shotWorld = makeWorld();
  copyWorld(shotWorld, w);

  const src = aiPerceived().ball;
  const b = shotWorld.ball;
  b.x = src.x; b.y = src.y; b.vx = src.vx; b.vy = src.vy; b.w = src.w;
  b.px = b.x; b.py = b.y;

  const box = aiBox(aiPaddle(w, aiSide));
  const arena = aiCfg().arena;
  const every = Math.max(1, Math.round(SHOT.sampleDt / SHOT_PRED_DT));
  const steps = Math.floor(SHOT.horizon / SHOT_PRED_DT);

  const path = [];
  const all = [];
  for (let i = 1; i <= steps; i++) {
    stepBall(shotWorld, SHOT_PRED_DT, true, true);
    if (b.x < -arena.goalDepth || b.x > arena.width + arena.goalDepth) break;
    if (i % every) continue;

    const t = i * SHOT_PRED_DT;
    all.push({ t, x: b.x, y: b.y });     // for drawing, wherever it goes

    // Only where our paddle could actually stand.
    if (b.x < box.x0 || b.x > box.x1 || b.y < box.y0 || b.y > box.y1) continue;
    path.push({ t, x: b.x, y: b.y, vx: b.vx, vy: b.vy });
  }
  shotLastPath = all;
  return path;
}

/* ==========================================================================
   ONE FLIGHT, IN CLOSED FORM
   ========================================================================== */

/* Launch angles that carry a ball from (px,py) to (tx,ty) at speed s. The
   standard projectile problem: two roots, a flat one and a lofted one, or none
   at all when the target is out of range at that speed. */
function shotLaunchAngles(px, py, tx, ty, s, g) {
  const dx = tx - px, dy = ty - py;
  const x = Math.abs(dx);
  if (x < 1e-4) return null;
  const s2 = s * s;
  const disc = s2 * s2 - g * (g * x * x + 2 * dy * s2);
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  return { sign: Math.sign(dx),
           low:  Math.atan((s2 - root) / (g * x)),
           high: Math.atan((s2 + root) / (g * x)) };
}

/* Does this launch actually score? Four evaluations of the same parabola at
   different x: it arrives, it goes in, it clears the net, it clears the
   ceiling. Returns null for a miss, or the crossing details for a goal. */
function shotFlight(px, py, vx, vy, aiSide) {
  const cfg = aiCfg(), arena = cfg.arena, g = cfg.phys.gravity, R = cfg.phys.ballR;
  const goalX = aiSide < 0 ? arena.width : 0;

  // 1. does it get there at all
  const dx = goalX - px;
  if (dx * vx <= 0) return null;
  const t = dx / vx;

  // 2. does it cross inside the mouth
  const yGoal = py + vy * t - 0.5 * g * t * t;
  const lo = arena.goalLip + R, hi = arena.goalLip + arena.goalHeight - R;
  if (yGoal < lo || yGoal > hi) return null;

  // 3. does it clear the net, if the net is between us and the goal
  const netX = arena.width / 2;
  const tn = (netX - px) / vx;
  if (tn > 0 && tn < t) {
    const yNet = py + vy * tn - 0.5 * g * tn * tn;
    if (yNet <= arena.netHeight + R) return null;
  }

  // 4. does it clear the ceiling — only if the apex falls inside the flight
  const tApex = vy / g;
  if (tApex > 0 && tApex < t) {
    if (py + vy * vy / (2 * g) >= arena.height - R) return null;
  }

  return { t, yGoal, margin: Math.min(yGoal - lo, hi - yGoal) };
}

/* How far the shot passes from the player's paddle, measured where it crosses
   their x. Their standing still for the whole flight is optimistic, but it is
   the only honest thing to assume — anything else is guessing at intent. */
function shotPassDistance(px, py, vx, vy, aiSide, tGoal) {
  const cfg = aiCfg();
  const pl = aiPlayerPaddle(aiSide);
  const tp = (pl.x - px) / vx;
  if (tp <= 0 || tp >= tGoal) return 99;      // never passes them
  const y = py + vy * tp - 0.5 * cfg.phys.gravity * tp * tp;
  return Math.abs(y - pl.y);
}

/* ==========================================================================
   THE SEARCH

   Returns the best shot found, or null. The caller decides what to do with
   that — this module never touches the AI's state or its setpoint.
   ========================================================================== */
function shotSearch(w, aiSide, wheelAngle) {
  const cfg = aiCfg(), arena = cfg.arena, phys = cfg.phys;
  const e = phys.paddleRest;
  const vpMax = maxPaddleSpeed();
  const hardest = (1 + e) * vpMax;          // the fastest ball this paddle makes
  const g = phys.gravity;

  const me = aiPaddle(w, aiSide);
  const lo = arena.goalLip + phys.ballR;
  const hi = arena.goalLip + arena.goalHeight - phys.ballR;
  const goalX = aiSide < 0 ? arena.width : 0;

  const path = shotPath(w, aiSide);
  let best = null;

  for (let ci = 0; ci < path.length; ci++) {
    const c = path[ci];

    /* Can we be there at all? Arriving late does not beat not going, so this
       is a hard filter rather than a preference. The ramp is the spin-up the
       spring spends before it is moving at speed. */
    const travel = Math.hypot(c.x - me.x, c.y - me.y);
    if (travel / vpMax + SHOT.ramp > c.t) continue;

    for (let ai_ = 0; ai_ < SHOT.aimPoints; ai_++) {
      // Across the mouth, not at its middle.
      const f = SHOT.aimPoints === 1 ? 0.5 : ai_ / (SHOT.aimPoints - 1);
      const aimY = lo + (hi - lo) * f;

      for (let si = 0; si < SHOT.speedSteps; si++) {
        const frac = SHOT.speedSteps === 1 ? 1
          : 1 - (1 - SHOT.slowest) * (si / (SHOT.speedSteps - 1));
        const s = hardest * frac;

        const sol = shotLaunchAngles(c.x, c.y, goalX, aimY, s, g);
        if (!sol) continue;

        for (let r = 0; r < 2; r++) {
          const theta = r ? sol.high : sol.low;
          const dirx = sol.sign * Math.cos(theta), diry = Math.sin(theta);
          const vx = dirx * s, vy = diry * s;

          const flight = shotFlight(c.x, c.y, vx, vy, aiSide);
          if (!flight) continue;

          /* Can the paddle actually produce this? Face square along the
             outgoing direction and swing that way; a ball already moving into
             the face does part of the work, so v_in along it reduces the swing
             needed. Beyond what the spring can deliver, the shot is imaginary. */
          const vinN = c.vx * dirx + c.vy * diry;
          const swing = (s + e * vinN) / (1 + e);
          if (swing > vpMax || !(swing >= 0)) continue;

          /* And can the WHEEL get the face there in time? A shot that is
             geometrically perfect and needs a ninety degree turn in two tenths
             of a second is not a shot. */
          const face = shotNearAngle(Math.atan2(-dirx, diry), wheelAngle);
          const notches = Math.abs(face - wheelAngle) / STEP_FINE;
          if (notches / AI.wheelSpeed > c.t) continue;

          const pass = shotPassDistance(c.x, c.y, vx, vy, aiSide, flight.t);
          const score =
              SHOT.wSpeed  * (s / hardest)
            + SHOT.wPass   * Math.min(pass, 3) / 3
            + SHOT.wMargin * Math.min(flight.margin, 0.5) / 0.5
            - SHOT.wTime   * (c.t / SHOT.horizon);

          if (!best || score > best.score) {
            best = { t: c.t, x: c.x, y: c.y, vinx: c.vx, viny: c.vy,
                     dirx, diry, speed: s, swing, angle: face,
                     goalY: flight.yGoal, flightT: flight.t, pass, score };
          }
        }
      }
    }
  }
  shotDebug = best ? { path: shotLastPath, shot: best } : null;
  return best;
}

/* The nearest equivalent of an angle to where the wheel already sits. atan2
   answers within one turn; the wheel's angle accumulates without bound, as a
   player's does. Choosing the near representative is what stops a shot asking
   for a full revolution to reach an angle already underfoot. */
function shotNearAngle(target, current) {
  const TAU = Math.PI * 2;
  return target + TAU * Math.round((current - target) / TAU);
}
