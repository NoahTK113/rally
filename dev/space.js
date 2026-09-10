/* Loaded as a classic script like the rest, so it shares the one global scope.

   ==========================================================================
   THE SPACE

   The world is not an arena with adjustable dimensions. It is a fixed place
   containing loose pieces, and an "arena" is an arrangement of them.

   Nothing morphs. The walls do not dissolve into other walls; they come apart
   and drift, and what is behind them was always behind them. The gravity was
   always curved - the source is far enough below that its field is flat to
   within a percent across the court, which is why nobody has noticed. The
   goals were always points. Move a goal toward the mass and the curvature
   becomes obvious without one number in the field changing.

   That is cheaper than interpolating shapes, and it is also the better lie:
   a player who goes back and looks finds it was true all along.

   ONE PRIMITIVE. Every collider in this game turns out to be a capsule - a
   segment with a radius:

       wall     r = 0            zero-thickness line, ball radius does the work
       corner   ax=bx, ay=by     a point with a radius, which is an arc
       net      r = netT/2       a vertical segment with thickness

   So there is one collision routine rather than three, and a piece is just a
   list of capsules with a transform.

   WHAT THIS FILE DOES NOT DO YET: draw anything, restrict where paddles may
   go, or interpolate between arrangements. Zones come back as a layer on top
   once the geometry is settled; drawing and the morph follow the wiring.
   ========================================================================== */

/* --------------------------------------------------------------------------
   THE SOURCE

   A point, far below the court. PHYS.gravity keeps its meaning and its slider,
   but it now reads as "the acceleration AT THE FIELD" and GM follows from it:

       GM = g * R^2

   At R = 2000 the field varies 1.2% across the court's twelve units and its
   direction fans 0.29 degrees at the ends. Imperceptible - which is the point.
   Arena 1 plays exactly as it always did while being, truthfully, in orbit.

   The source does not track the width slider. At this distance a few metres of
   offset tilts the field by thousandths of a degree, and pretending otherwise
   would be precision theatre.
   -------------------------------------------------------------------------- */
const SPACE = {
  source: { x: 10, y: -2000 },
  goalR: 0.55,          // how close the ball must come to be swallowed
  pullR: 2.5,           // and how far out the pull reaches
};

function spaceGM() { return PHYS.gravity * SPACE.source.y * SPACE.source.y; }

/* Acceleration at a point. Returns the vector rather than a magnitude, because
   the whole reason this exists is that it stops pointing straight down. */
function spaceGravity(x, y, out) {
  const dx = SPACE.source.x - x, dy = SPACE.source.y - y;
  const d2 = dx * dx + dy * dy;
  const d = Math.sqrt(d2) || 1;
  const a = spaceGM() / d2;
  out.x = a * dx / d;
  out.y = a * dy / d;
  return out;
}

/* --------------------------------------------------------------------------
   PIECES

   A piece owns capsules in LOCAL coordinates and carries a transform. At rest
   every transform is identity, so the world-space capsules are bit for bit the
   ones the old arenaFeatures produced - which is the claim this whole file has
   to earn before anything is allowed to move.

   Local coordinates are centred on the piece so that spin means what it should.
   A wall that breaks off and tumbles turns about itself rather than swinging
   around the far corner of the court.
   -------------------------------------------------------------------------- */
function spaceMakePiece(id, caps) {
  // centre on the mean of the endpoints, then rewrite the capsules about it
  let sx = 0, sy = 0, n = 0;
  for (const c of caps) { sx += c.ax + c.bx; sy += c.ay + c.by; n += 2; }
  const cx = n ? sx / n : 0, cy = n ? sy / n : 0;
  return {
    id,
    x: cx, y: cy, a: 0,           // where it is
    vx: 0, vy: 0, w: 0,           // and how it is moving
    caps: caps.map(c => ({
      ax: c.ax - cx, ay: c.ay - cy,
      bx: c.bx - cx, by: c.by - cy,
      r: c.r || 0,
    })),
  };
}

/* Which piece each edge of the outline belongs to. The outline is the one
   arenaPoints has always returned; this only says where it comes apart. Two
   edges have no collider at all - the backs of the goal boxes, which the ball
   passes straight through. */
const SPACE_EDGE_OWNER = [
  'endLowerL',  // (0,0)   -> (0,y0)
  'pocketL',    // (0,y0)  -> (-d,y0)
  null,         // (-d,y0) -> (-d,y1)   the back: no collider
  'pocketL',    // (-d,y1) -> (0,y1)
  'endUpperL',  // (0,y1)  -> (0,H)
  'ceiling',    // (0,H)   -> (W,H)
  'endUpperR',  // (W,H)   -> (W,y1)
  'pocketR',    // (W,y1)  -> (W+d,y1)
  null,         // (W+d,y1)-> (W+d,y0)  the back: no collider
  'pocketR',    // (W+d,y0)-> (W,y0)
  'endLowerR',  // (W,y0)  -> (W,0)
  'floor',      // (W,0)   -> (0,0)
];

const SPACE_CHUTE = 0.8;   // how far the pocket rails run past the back plane

/* Build the pieces from the outline, using the same trimming and corner maths
   the renderer and the old collider used - so the geometry is identical by
   construction rather than by my arithmetic. Each capsule remembers which edge
   it came from, which is the only thing arenaFeatures did not record and the
   only thing needed to cut the contour into pieces. */
function spaceBuildPieces() {
  const pts = arenaPoints(), n = pts.length;
  const W = A.width, d = A.goalDepth;
  const backL = -d, backR = W + d;
  const atBack = x => Math.abs(x - backL) < 1e-9 || Math.abs(x - backR) < 1e-9;

  let shortest = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    shortest = Math.min(shortest, Math.hypot(b.x - a.x, b.y - a.y));
  }
  const r = Math.min(A.cornerR, shortest * 0.45);

  // corner rounding: a trim off each end of the meeting edges, and an arc
  const trim = new Array(n).fill(0);
  const arcAt = new Array(n).fill(null);
  if (r > 1e-6) {
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
      const inx = cur.x - prev.x, iny = cur.y - prev.y;
      const outx = next.x - cur.x, outy = next.y - cur.y;
      if (inx * outy - iny * outx <= 0) continue;      // not reflex; no arc

      let ax = -inx, ay = -iny; const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
      let bx = outx, by = outy; const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
      const dot = Math.max(-1, Math.min(1, ax * bx + ay * by));
      const sinH = Math.sqrt(Math.max(1e-9, (1 - dot) / 2));
      const cosH = Math.sqrt(Math.max(0, (1 + dot) / 2));

      let mx = ax + bx, my = ay + by; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
      arcAt[i] = { x: cur.x + mx * r / sinH, y: cur.y + my * r / sinH, r };
      trim[i] = r * cosH / sinH;
    }
  }

  const groups = {};
  const add = (owner, cap) => { (groups[owner] = groups[owner] || []).push(cap); };

  for (let i = 0; i < n; i++) {
    const owner = SPACE_EDGE_OWNER[i];
    if (!owner) continue;                              // the goal backs

    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const t0 = trim[i], t1 = trim[(i + 1) % n];
    if (len - t0 - t1 <= 1e-6) continue;               // swallowed by its arcs

    const cap = { ax: a.x + ux * t0, ay: a.y + uy * t0,
                  bx: b.x - ux * t1, by: b.y - uy * t1, r: 0 };

    /* The pocket rails stay solid past the back plane so the ball leaves down a
       clean chute rather than catching on an endpoint it can no longer see. */
    if (Math.abs(cap.ay - cap.by) < 1e-9) {
      if (atBack(a.x)) cap.ax += (a.x < 0 ? -SPACE_CHUTE : SPACE_CHUTE);
      if (atBack(b.x)) cap.bx += (b.x < 0 ? -SPACE_CHUTE : SPACE_CHUTE);
    }
    add(owner, cap);
  }

  /* A corner arc belongs to the piece owning the edge that arrives at it. When
     that piece leaves, its corner goes with it. */
  for (let i = 0; i < n; i++) {
    if (!arcAt[i]) continue;
    const owner = SPACE_EDGE_OWNER[(i - 1 + n) % n] || SPACE_EDGE_OWNER[i];
    if (!owner) continue;
    add(owner, { ax: arcAt[i].x, ay: arcAt[i].y,
                 bx: arcAt[i].x, by: arcAt[i].y, r: arcAt[i].r });
  }

  // the net: a capsule, and the only collider that was never part of the outline
  const rNet = A.netT / 2;
  add('net', { ax: A.width / 2, ay: 0,
               bx: A.width / 2, by: Math.max(0, A.netHeight - rNet), r: rNet });

  return Object.keys(groups).map(id => spaceMakePiece(id, groups[id]));
}

let spacePieces = [];
let spaceOrder = [];      // every capsule, flat, in the order they are resolved
let _spaceKey = '';

/* THE ORDER MATTERS, and it is not the order the pieces happen to be in.

   Contacts are resolved as they are found, so when the ball touches two
   surfaces in one substep - a corner, or the foot of the net - which is
   handled first changes the result. The old code ran collideNet, then every
   arena segment, then every arc. Iterating piece by piece would interleave
   those, and the geometry would be identical while the play was not.

   So the capsules are flattened once into that same order: the net, then all
   the flat surfaces, then all the rounded corners. */
function spaceBuildOrder() {
  const flat = [];
  for (const p of spacePieces)
    for (const cap of p.caps) flat.push({ p, cap });

  const rank = e => e.p.id === 'net' ? 0 : e.cap.r > 0 ? 2 : 1;
  return flat.sort((a, b) => rank(a) - rank(b));
}

/* Rebuilt only when the dimensions behind it change, the same bargain
   arenaFeatures struck - the tuning panel may move a wall, and nothing else
   does yet. Once pieces start moving under their own steam this becomes a
   build-once, and the transform is what varies. */
function spaceEnsure() {
  const key = [A.width, A.height, A.goalLip, A.goalHeight, A.goalDepth,
               A.cornerR, A.netHeight, A.netT].join(',');
  if (key === _spaceKey && spacePieces.length) return;
  _spaceKey = key;
  spacePieces = spaceBuildPieces();
  spaceOrder = spaceBuildOrder();
}

/* --------------------------------------------------------------------------
   COLLISION

   One routine for every surface in the world, because every surface is a
   capsule. The piece's own motion goes in as surface velocity, which is the
   same path collidePaddle already uses - a drifting wall and a swung paddle
   are the same problem, and the solver has always known how to take spin off a
   moving face.
   -------------------------------------------------------------------------- */
function spaceCollide(w) {
  spaceEnsure();
  const b = w.ball, R = PHYS.ballR;

  for (const e of spaceOrder) {
    const p = e.p, cap = e.cap;
    const c = Math.cos(p.a), s = Math.sin(p.a);

    // capsule ends in world space
    const ax = p.x + cap.ax * c - cap.ay * s, ay = p.y + cap.ax * s + cap.ay * c;
    const bx = p.x + cap.bx * c - cap.by * s, by = p.y + cap.bx * s + cap.by * c;

    const ex = bx - ax, ey = by - ay;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? ((b.x - ax) * ex + (b.y - ay) * ey) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + ex * t, qy = ay + ey * t;

    let dx = b.x - qx, dy = b.y - qy;
    let d = Math.hypot(dx, dy);
    const sum = R + cap.r;
    if (d >= sum) continue;
    if (d < 1e-9) { dx = 0; dy = 1; d = 1e-9; }

    // where the contact point is going, if the piece is going anywhere
    const rx = qx - p.x, ry = qy - p.y;
    const svx = p.vx - p.w * ry, svy = p.vy + p.w * rx;

    const j = resolveContact(b, dx / d, dy / d, sum - d,
                             PHYS.restitution, PHYS.friction, svx, svy);
    if (j > EV_MIN) pushEvent(w, p.id === 'net' ? 'net' : 'wall', j, b.x);
  }
}

/* --------------------------------------------------------------------------
   THE GOALS

   Points, where the black holes have always been: at the back of each pocket
   rather than at the mouth. So the ball crosses the lip, is drawn in, and is
   swallowed - which is a beat later than the old test, which fired the instant
   x crossed zero. Deliberate: it is the difference between a light going on
   and something being eaten.
   -------------------------------------------------------------------------- */
function spaceGoals() {
  const y = A.goalLip + A.goalHeight / 2, d = A.goalDepth / 2;
  return [
    { x: -d,           y, scores: +1 },   // ball in here, side +1 scored
    { x: A.width + d,  y, scores: -1 },
  ];
}

// Which side scored, or 0. Nearest goal wins; they cannot overlap.
function spaceScored(b) {
  for (const g of spaceGoals()) {
    const dx = b.x - g.x, dy = b.y - g.y;
    if (dx * dx + dy * dy <= SPACE.goalR * SPACE.goalR) return g.scores;
  }
  return 0;
}

/* The pull that used to be a constant shove deeper into the pocket. Radial now,
   toward the point, so it reads as the thing doing the swallowing rather than
   as a rule about a box. */
function spaceGoalPull(b, out) {
  out.x = 0; out.y = 0;
  for (const g of spaceGoals()) {
    const dx = g.x - b.x, dy = g.y - b.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > SPACE.pullR * SPACE.pullR) continue;
    const d = Math.sqrt(d2) || 1;
    out.x += PHYS.goalPull * dx / d;
    out.y += PHYS.goalPull * dy / d;
  }
  return out;
}

/* --------------------------------------------------------------------------
   THE VIEW

   The smallest window holding the ball, the player's own paddles and both
   goals. The opponent may leave the frame; an arrow can point at them later,
   and that is a layer on top rather than a rule about the camera.

   Note what falls out of it: since both goals are always included, the view can
   never be narrower than the goal separation - which in arena 1 is the whole
   court. So this rule leaves arena 1's camera exactly where it was.
   -------------------------------------------------------------------------- */
function spaceView(w, side, out) {
  const b = w.ball;
  let x0 = b.x, x1 = b.x, y0 = b.y, y1 = b.y;
  const take = (x, y) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  for (const g of spaceGoals()) take(g.x, g.y);
  for (let i = 0; i < MATCH.paddles; i++) {
    const p = w.p[idOf(side, i)];
    if (p) take(p.x, p.y);
  }
  out.x0 = x0; out.x1 = x1; out.y0 = y0; out.y1 = y1;
  return out;
}
