/* Loaded as a classic script, not a module: an ES module needs CORS, which a
   page opened from file:// cannot satisfy, and local testing would break. So
   everything here shares the one global scope, exactly as it did inline.

   Nothing in this file runs at load time — STEPS holds arrow functions that
   are only called later — so it can be loaded before or after the main script
   without caring. That is what made the tutorial the right piece to pull out
   first. */

/* ==========================================================================
   TUTORIAL

   A practice session that holds the world still and walks through one control
   at a time, advancing only when the player has actually done the thing. It is
   a layer on top of the game rather than a mode inside it: the simulation has
   no idea a tutorial is running, and every step is a text prompt plus a
   predicate over ordinary game state.

   Every step is READ, then DONE, and those want opposite things from the
   screen. Reading wants the world still and the words in the middle where the
   eye already is. Doing wants the world running and the words out of the way,
   because the middle of the screen is the middle of the pitch.

   So a step has two phases. It arrives frozen with the instruction centred and
   a line saying to press space; space starts it, and the same instruction
   moves to the top rail where it can still be read but covers nothing. That
   also means the player decides when to begin rather than being dropped into a
   live ball while still reading.

   Adding a step is one entry in STEPS. Nothing else needs to change.
   ========================================================================== */
const tut = {
  active: false,
  phase: 'start',   // 'start' click | 'brief' reading | 'active' doing | 'praise' well done
  step: 0,
  held: 0,          // seconds the current step has been satisfied
  praiseT: 0,       // seconds the WELL DONE card has been up
  activeT: 0,       // seconds this step has been under way, for steps with nothing to do
  moved: 0,         // metres the held paddle has travelled
  turned: 0,        // radians of commanded rotation
  fine: 0,          // radians commanded while the fine modifier was held
  switched: 0,      // paddle handoffs
  hits: 0,          // paddle contacts with the ball
  goals: 0,
};

/* The one box before the tutorial proper. It replaces the ordinary CLICK TO
   CAPTURE THE MOUSE card rather than joining it: two prompts on screen at once,
   one centred and one at the bottom, both asking for a click, was the first
   thing a new player saw. */
const TUT_START = 'First, <b>click anywhere on the field</b> to start the game.';
const TUT_READY = 'Press the <b>space bar</b> when you are ready.';
const TUT_PRAISE = 'Well done.';
const TUT_PRAISE_T = 3.0;            // seconds the card holds before fading
const TUT_FADE_T   = 0.3;            // and how long the fade itself takes

/* The wheel turns in 30 degree steps, so 90 is three of them and 45 is not
   reachable at all without the fine modifier. A tolerance under half a fine
   step keeps the neighbours out: at 3.5 degrees, 37.5 and 52.5 both miss. */
const TUT_ANGLE_TOL = 3.5 * Math.PI / 180;

/* A paddle is a rectangle, so it looks the same at a and a+180. Fold the
   commanded angle into [0,180) and both ways up count as the same answer -
   otherwise "make it vertical" would have a right and a wrong 90. */
function tutAngleIs(deg) {
  const target = deg * Math.PI / 180;
  let a = intent.ta % Math.PI;
  if (a < 0) a += Math.PI;
  return Math.abs(a - target) < TUT_ANGLE_TOL ||
         Math.abs(a - target - Math.PI) < TUT_ANGLE_TOL ||
         Math.abs(a - target + Math.PI) < TUT_ANGLE_TOL;
}

/* The two tilts that send the ball toward the goal this player attacks.

   The upward-facing normal of a paddle at angle a is whichever of ±(-sin a,
   cos a) points up. At 30° and 60° that normal leans toward x = 0; at 120° and
   150° it leans toward x = width. Side +1 scores into x = 0 — checkGoal awards
   it when the ball crosses there — so +1 wants the first pair and -1 the
   second. Mirrored rather than written down twice, and the diagram is built
   from the same numbers so it can never disagree with the gate. */
function tutTiltAngles() { return mySide > 0 ? [30, 60] : [120, 150]; }

/* A small picture of the two acceptable positions, because "at an angle" has a
   mirror image that is exactly wrong and no wording makes that as clear as
   seeing both. SVG y runs downward, so a world angle of +a is rotate(-a). */
function tutTiltDiagram() {
  const cells = tutTiltAngles().map((deg, i) => {
    const a = deg * Math.PI / 180;
    let nx = -Math.sin(a), ny = Math.cos(a);
    if (ny < 0) { nx = -nx; ny = -ny; }          // the face that is uppermost
    const cx = 70 + i * 130, cy = 56;
    const ex = cx + nx * 30, ey = cy - ny * 30;   // outgoing, in SVG coords
    const ang = Math.atan2(ey - cy, ex - cx);
    const h = 7;
    return (
      '<g>' +
      '<circle cx="' + cx + '" cy="16" r="5" fill="#ffffff" opacity=".55"/>' +
      '<line x1="' + cx + '" y1="22" x2="' + cx + '" y2="' + (cy - 12) + '" ' +
        'stroke="#ffffff" stroke-opacity=".35" stroke-width="2" stroke-dasharray="3 3"/>' +
      '<rect x="' + (cx - 30) + '" y="' + (cy - 4) + '" width="60" height="8" rx="4" ' +
        'fill="#22d3ee" transform="rotate(' + (-deg) + ' ' + cx + ' ' + cy + ')"/>' +
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + ex + '" y2="' + ey + '" ' +
        'stroke="#ffffff" stroke-width="2"/>' +
      '<polygon fill="#ffffff" points="' +
        ex + ',' + ey + ' ' +
        (ex - h * Math.cos(ang - 0.45)) + ',' + (ey - h * Math.sin(ang - 0.45)) + ' ' +
        (ex - h * Math.cos(ang + 0.45)) + ',' + (ey - h * Math.sin(ang + 0.45)) + '"/>' +
      '<text x="' + cx + '" y="100" text-anchor="middle" fill="#ffffff" ' +
        'font-size="12" font-family="ui-monospace, Consolas, monospace">' + deg + '°</text>' +
      '</g>'
    );
  }).join('');
  return '<svg viewBox="0 0 270 110" width="270" height="110">' + cells + '</svg>';
}

const STEPS = [
  {
    text: 'Move your mouse to <b>control your paddle</b>.',
    hint: 'the paddle chases the cursor; the line between them is the pull',
    done: () => tut.moved > 25,
  },
  {
    text: 'You can also <b>roll the mouse wheel</b> to tilt and spin your paddle. ' +
          'Try rotating the paddle so that it is <b>vertical</b>.',
    hint: 'the wheel turns in 30° steps, so upright is exactly three of them',
    done: () => tutAngleIs(90),
  },
  {
    text: 'Now try <b>tilting your paddle at an angle</b>. ' +
          'This is often a good angle for hitting the ball.',
    /* 30 or 60, both one coarse step from flat or upright. An earlier draft
       asked for 45, which the 30° wheel cannot reach at all without the fine
       modifier - a step the player could not finish with what they had been
       taught so far.

       Which two angles depends on the side. A tilt is not just an angle, it is
       a DIRECTION: tilted one way the face throws the ball up the field, and
       the mirror image of it throws the ball into your own half. Both are
       "an angle", and only one is the lesson. tutTiltAngles picks the pair
       that faces the goal being attacked. */
    hint: 'tilt it so the face points up the field, toward the goal you are attacking',
    diagram: () => tutTiltDiagram(),
    done: () => { const [a, b] = tutTiltAngles(); return tutAngleIs(a) || tutAngleIs(b); },
  },
  {
    text: 'The goal of the game is simply to <b>score on your opponent</b> ' +
          'and <b>defend your own goal</b>.',
    hint: 'nothing to do here — read the field',
    goals: true,                       // draw the two labels while this one runs
    done: () => tut.activeT > 5,
  },
  {
    text: 'Press <b>space</b> to take hold of your other paddle.',
    hint: 'the one you let go of stays where you left it, and is still solid',
    done: () => tut.switched >= 2,
    skip: () => MATCH.paddles < 2,
  },
  {
    text: 'Now <b>hit the ball</b>.',
    hint: 'swing into it — a moving paddle adds pace, a still one only returns it',
    enter: () => { const w = server.world; w.phase = PHASE.PLAY; w.ballHidden = false; serve(w); },
    done: () => tut.hits >= 3,
  },
  {
    text: 'Put it in the <b>far goal</b> to score.',
    hint: 'over the net, under the crossbar',
    done: () => tut.goals >= 1,
  },
  {
    text: "That's everything. <b>Good luck.</b>",
    hint: 'returning to the menu',
    done: () => tut.held > 2.5,
  },
];

function tutStart() {
  tut.active = true;
  tut.phase = 'start';
  tut.step = 0;
  tut.held = 0;
  tutResetCounters();
  /* Quitting part-way leaves the step you were on marked as entered, and its
     enter() would then be skipped next time round — for the hitting step that
     means no ball is ever served. */
  for (const s of STEPS) s.entered = false;
  document.body.classList.add('tutorial');
  paintTutorial();
}

function tutStop() {
  tut.active = false;
  tut.phase = 'start';
  document.body.classList.remove('tutorial');
}

/* Counters are zeroed as a step BEGINS, not as it is set up. The mouse still
   moves while a brief is being read — the pointer is captured and the cursor
   tracks it, the world simply is not stepping — so without this a player who
   fidgeted while reading would find the movement step already satisfied and
   watch it complete itself. */
function tutResetCounters() {
  tut.moved = tut.turned = tut.fine = 0;
  tut.switched = tut.hits = tut.goals = 0;
  tut.activeT = 0;
}

/* The world stands still for anything that is being read. Asked by the frame
   loop, which already knows how to hold the simulation for a pause. */
function tutHold() { return tut.active && tut.phase !== 'active'; }

/* Space starts the step being read. Returns whether it took the key, so the
   ordinary handler can leave it alone — otherwise the same press that begins
   the "press space to switch paddles" step would also switch the paddles. */
function tutSpace() {
  if (!tut.active || tut.phase !== 'brief') return false;
  tut.phase = 'active';
  tut.held = 0;
  tutResetCounters();
  paintTutorial();
  return true;
}

function paintTutorial() {
  const box = $('tut');
  box.classList.remove('fade');       // a repaint is always something to see
  const start  = tut.phase === 'start';
  const brief  = tut.phase === 'brief';
  const praise = tut.phase === 'praise';
  const s = (start || praise) ? null : STEPS[tut.step];
  if (!start && !praise && !s) return;

  $('tutText').innerHTML = start ? TUT_START : praise ? TUT_PRAISE : s.text;
  // innerHTML, not textContent: hints carry <b> now.
  $('tutHint').innerHTML = (start || praise) ? '' : (s.hint || '');
  const diagram = (!start && !praise && s.diagram) ? s.diagram() : '';
  $('tutDiagram').innerHTML = diagram;
  $('tutDiagram').style.display = diagram ? '' : 'none';
  $('tutReady').innerHTML = brief ? TUT_READY : '';
  $('tutReady').style.display = brief ? '' : 'none';

  // Centred for anything being read; on the top rail only while playing.
  const reading = start || brief || praise;
  box.classList.toggle('mid', reading);
  box.classList.toggle('top', !reading);

  let dots = '';
  for (let i = 0; i < STEPS.length; i++) {
    dots += '<i class="' + (i === tut.step && !start ? 'on' : i < tut.step ? 'past' : '') + '"></i>';
  }
  $('tutDots').innerHTML = dots;
}

// Called once per frame, including while the world is held — the tutorial has
// to keep watching in exactly the states where the simulation is not running.
function pumpTutorial(dt) {
  if (!tut.active || !running) return;

  /* Nothing begins until the mouse is captured, and capturing it is the click
     the first card asks for. Polled rather than hooked into the pointer-lock
     handler, which keeps the lock code free of tutorial special cases. */
  if (tut.phase === 'start') {
    if (pointerLocked) { tut.phase = 'brief'; paintTutorial(); }
    return;
  }

  /* WELL DONE, then out. The card holds, fades over its last moments, and the
     next brief is painted as it disappears - so the two never overlap and the
     new instruction arrives on a clean screen. The world stays held throughout,
     since tutHold only lets 'active' run. */
  if (tut.phase === 'praise') {
    tut.praiseT += dt;
    if (tut.praiseT > TUT_PRAISE_T - TUT_FADE_T) $('tut').classList.add('fade');
    if (tut.praiseT >= TUT_PRAISE_T) tutAdvance();
    return;
  }

  const s = STEPS[tut.step];
  if (!s) return;
  if (s.skip && s.skip()) { tutAdvance(); return; }
  if (tut.phase !== 'active') return;     // reading; nothing counts yet

  if (!s.entered) { s.entered = true; if (s.enter) s.enter(); }
  tut.activeT += dt;

  // A beat after the predicate holds, so a completed instruction is visibly
  // acknowledged rather than vanishing under the player's hands.
  if (s.done()) {
    tut.held += dt;
    if (tut.held > 0.45) tutPraise();
  } else {
    tut.held = 0;
  }
}

/* Every gate earns a WELL DONE - except the last step, which is the sign-off
   and has nothing to congratulate. */
function tutPraise() {
  if (tut.step >= STEPS.length - 1) { tutAdvance(); return; }
  tut.phase = 'praise';
  tut.praiseT = 0;
  tut.held = 0;
  paintTutorial();
}

function tutAdvance() {
  STEPS[tut.step].entered = false;
  tut.step++;
  tut.held = 0;
  if (tut.step >= STEPS.length) { tutStop(); leaveGame(); return; }
  tut.phase = 'brief';                    // every step is read before it is done
  paintTutorial();
}

/* THE TWO GOALS, labelled, while the step that explains them runs.

   Drawn in screen space off the same view mapping the scoreboard uses, so the
   labels sit beside the goals at any zoom without needing the world transform.

   Side +1 scores into x = 0 - checkGoal awards +1 when the ball crosses there -
   so the goal you attack is the one at the far end from the one you defend, and
   both follow mySide rather than being written down. */
function tutShowsGoals() {
  const s = STEPS[tut.step];
  return tut.active && tut.phase === 'active' && s && s.goals;
}

function drawTutorialGoals(ctx) {
  if (!tutShowsGoals()) return;
  const sx = wx => view.ox + wx * view.scale;
  const sy = wy => view.oy - wy * view.scale;
  const midY = (goalY0() + goalY1()) / 2;

  const marks = [
    { x: mySide > 0 ? 0 : A.width, text: 'THEIR GOAL — SCORE HERE' },
    { x: mySide > 0 ? A.width : 0, text: 'YOUR GOAL — DEFEND IT'   },
  ];

  ctx.save();
  ctx.font = `700 ${Math.max(11, Math.round(view.scale * 0.30))}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(1.5, view.scale * 0.035);

  for (const m of marks) {
    const inward = m.x === 0 ? 1 : -1;              // into the field, whichever end
    const tipX = sx(m.x + inward * 0.25);
    const tipY = sy(midY);
    const labX = sx(m.x + inward * 2.6);
    const labY = sy(goalY1() + 1.6);

    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(labX, labY + view.scale * 0.18);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // arrowhead, pointing at the mouth
    const ang = Math.atan2(tipY - (labY + view.scale * 0.18), tipX - labX);
    const h = Math.max(6, view.scale * 0.16);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - h * Math.cos(ang - 0.4), tipY - h * Math.sin(ang - 0.4));
    ctx.lineTo(tipX - h * Math.cos(ang + 0.4), tipY - h * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();

    ctx.textAlign = inward > 0 ? 'left' : 'right';
    ctx.fillText(m.text, labX, labY);
  }
  ctx.restore();
}

/* The counters below are fed from the ordinary input path and from the
   simulation's own event log, so the tutorial observes the game rather than
   instrumenting it. */
function tutOnMove(dx, dy) { if (tut.active) tut.moved += Math.hypot(dx, dy); }
function tutOnTurn(rad, fine) {
  if (!tut.active) return;
  tut.turned += Math.abs(rad);
  if (fine) tut.fine += Math.abs(rad);
}
function tutOnSwitch() { if (tut.active) tut.switched++; }
function tutOnEvent(kind) {
  if (!tut.active) return;
  if (kind === 'paddle') tut.hits++;
  if (kind === 'goal') tut.goals++;
}
