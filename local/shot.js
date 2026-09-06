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
  angleSteps: 36,     // launch directions tried at each candidate contact
  angleLo: -0.45,     // rad, relative to horizontal toward the goal
  angleHi: 1.30,      // rad — a steep lob is still worth testing
  ramp: 0.10,         // s of the paddle's spin-up, unavailable for travelling
  swingTime: 0.20,    // s of swing: how long before contact the drive begins.
                      //   A guess, and tunable. Its floor is about three
                      //   velocity time constants — roughly 45ms at the current
                      //   tuning — below which the paddle never reaches pace.

  minWindow: 0.09,    /* s. How long the ball stays within reach along the
                         paddle's SPINE — the direction a timing slip carries it
                         off the end. Everything else about a contact is
                         forgiving; that is the axis where being early or late
                         means missing entirely.

                         A time, not an angle, and the difference matters: a
                         slow ball drifting exactly along the spine has a window
                         of most of a second and needs no precision at all,
                         while an angle measure would have called it the worst
                         shot on the board. */

  // Scoring weights. What makes one shot better than another.
  wWindow: 1.2,       // and among the possible ones, prefer the forgiving
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
    path.push({ t, x: b.x, y: b.y, vx: b.vx, vy: b.vy, w: b.w });
  }
  shotLastPath = all;
  return path;
}

/* ==========================================================================
   ONE FLIGHT, IN CLOSED FORM
   ========================================================================== */

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
  const toGoal = aiSide < 0 ? 1 : -1;   // x direction of the goal we attack

  /* How much of the swing is actually spent travelling. The paddle starts
     from REST at the staging point, and the spring takes a velocity time
     constant to get going, so it covers v*(tau - tc), not v*tau. Staging at the
     naive distance leaves it a constant 15cm short — about 15ms late, and at
     ball speeds another 15cm of travel on top. Roughly a ball diameter of miss,
     which is an edge contact rather than a shot. */
  const tc = 1 / (2 * cfg.feel.posDamp * (2 * Math.PI * cfg.feel.posFreq));
  const usable = Math.max(0.01, SHOT.swingTime - tc);

  const path = shotPath(w, aiSide);
  const box = aiBox(me);
  let best = null;

  for (let ci = 0; ci < path.length; ci++) {
    const c = path[ci];

    /* Too soon to stage and swing at all. The real feasibility test is against
       the STAGING point and happens once the direction is known — a contact is
       only reachable in a way that is any use if the paddle can get behind it
       first. This is the cheap necessary condition. */
    if (c.t <= SHOT.swingTime + SHOT.ramp) continue;

    for (let k = 0; k < SHOT.angleSteps; k++) {
      /* Sweep the FACE ANGLE, and let the contact say where the ball goes.

         The outgoing direction is not ours to choose. resolveContact returns

             v_out = v_in + jn*n + jt*t

         so the ball's velocity ALONG THE FACE survives the hit, cut only by
         friction. Only the normal component is replaced. Building the outgoing
         velocity as speed*n, as this used to, is right for a ball arriving dead
         square and wrong for every other one: a 12 m/s ball meeting the face
         60 degrees off the normal carries 10 m/s along it, and leaves about 40
         degrees away from where a pure-normal model puts it.

         So the sweep runs over the face normal, and the outgoing velocity comes
         out of the same arithmetic the solver will run at contact. */
      const theta = SHOT.angleLo + (SHOT.angleHi - SHOT.angleLo) * (k / (SHOT.angleSteps - 1));
      const nx = toGoal * Math.cos(theta), ny = Math.sin(theta);
      const tx = -ny, ty = nx;

      // the paddle drives along its own normal, at full speed
      const svx = nx * vpMax, svy = ny * vpMax;

      // contact-point velocity relative to that moving face, spin included
      const R = phys.ballR;
      const cvx = c.vx + c.w * ny * R - svx;
      const cvy = c.vy - c.w * nx * R - svy;
      const vn = cvx * nx + cvy * ny;
      if (vn >= 0) continue;              // the face is running away from it

      const vt = cvx * tx + cvy * ty;
      const er = Math.abs(vn) < phys.restThreshold ? 0 : e;
      const jn = -(1 + er) * vn;
      let jt = -vt / 3;
      const maxF = phys.paddleFriction * jn;
      if (jt >  maxF) jt =  maxF;
      if (jt < -maxF) jt = -maxF;

      const vx = c.vx + jn * nx + jt * tx;
      const vy = c.vy + jn * ny + jt * ty;
      const s = Math.hypot(vx, vy);
      if (s <= 0.5) continue;                 // no useful pace to be had here

      /* How much timing slack the contact allows. The paddle's spine runs
         perpendicular to its normal, so the ball's speed ALONG the spine is
         what decides how long it stays on the paddle rather than past the end
         of it. Divide the reach along that axis by that speed and the answer
         is a window in seconds.

         Magnitude, not direction: a ball creeping along the spine is easy to
         meet however parallel it is, and only a fast one makes the timing
         tight. */
      const vTan = Math.abs(c.vx * tx + c.vy * ty);
      const span = arena.paddleLength / 2 + phys.ballR;
      const windowS = vTan > 1e-3 ? 2 * span / vTan : 99;
      if (windowS < SHOT.minWindow) continue;

      const flight = shotFlight(c.x, c.y, vx, vy, aiSide);
      if (!flight) continue;

      const swing = vpMax;                    // always the hardest we can hit

          /* THE STAGING POINT. Approaching a contact by the shortest route
             says nothing about the DIRECTION of approach, and the direction is
             what decides where the ball goes: a paddle dropping onto a rising
             ball from above drives it back into the floor however right the
             contact point was.

             So the paddle stands back along the shot's own line and drives
             forward through it. How far back is the swing speed times the
             usable part of the swing. */
          const back = swing * usable;
          const sx = c.x - nx * back, sy = c.y - ny * back;
          if (sx < box.x0 || sx > box.x1 || sy < box.y0 || sy > box.y1) continue;

          /* The deadline is the START of the swing, not the contact. Being able
             to reach the contact in time is no use if there was never a moment
             to get behind it. */
          const ready = c.t - SHOT.swingTime;
          const travel = Math.hypot(sx - me.x, sy - me.y);
          if (travel / vpMax + SHOT.ramp > ready) continue;

          /* The wheel answers to the same deadline: the face has to be set
             before the drive begins, not by the moment of contact. */
          const face = shotNearAngle(Math.atan2(-nx, ny), wheelAngle);
          const notches = Math.abs(face - wheelAngle) / STEP_FINE;
          if (notches / AI.wheelSpeed > ready) continue;

          const pass = shotPassDistance(c.x, c.y, vx, vy, aiSide, flight.t);
          const score =
              SHOT.wWindow * Math.min(windowS, 0.30) / 0.30
            + SHOT.wSpeed  * Math.min(s / hardest, 1)
            + SHOT.wPass   * Math.min(pass, 3) / 3
            + SHOT.wMargin * Math.min(flight.margin, 0.5) / 0.5
            - SHOT.wTime   * (c.t / SHOT.horizon);

          if (!best || score > best.score) {
            best = { t: c.t, x: c.x, y: c.y, vinx: c.vx, viny: c.vy,
                     dirx: nx, diry: ny, vx, vy, speed: s, swing, angle: face,
                     sx, sy, swingT: SHOT.swingTime,
                     goalY: flight.yGoal, flightT: flight.t, pass, score };
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
