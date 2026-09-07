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

   FOUR KINDS OF CARD, because a step that asks for something and a step that
   only tells you something want different screens:

     brief   centred, world held      instruction, then "press space"
     task    top rail, world RUNNING  the same instruction while you do it
     praise  centred, world held      "Well done", three seconds, fades
     note    top rail, world held     something to read, space to move on
     finish  centred, world held      the sign-off, with buttons out

   Reading wants the world still and the words in the middle where the eye
   already is. Doing wants the world running and the words out of the way,
   because the middle of the screen is the middle of the pitch. A note is the
   pair pulled apart: nothing to do, so nothing to run, but the words still
   belong at the top because there are labels on the field to look at.

   Adding a step is one entry in STEPS. Nothing else needs to change.
   ========================================================================== */
const tut = {
  active: false,
  phase: 'start',   // start | brief | active | praise | note | finish
  step: 0,
  held: 0,          // seconds the current step's predicate has held
  praiseT: 0,       // seconds the WELL DONE card has been up
  activeT: 0,       // seconds this step has been under way
  moved: 0,         // metres the held paddle has travelled
  turned: 0,        // radians of commanded rotation
  fine: 0,          // radians commanded while the fine modifier was held
  switched: 0,      // paddle handoffs
  hits: 0,          // paddle contacts with the ball
  goals: 0,
  serves: 0,        // manual re-serves, from F
  spins: 0,         // completed flicks; see tutOnTurn
  spinBuf: [],      // recent wheel deltas, for the sliding window
  spinLock: 0,      // clock time before which another spin cannot count
};

/* The one box before the tutorial proper. It replaces the ordinary CLICK TO
   CAPTURE THE MOUSE card rather than joining it: two prompts on screen at once,
   one centred and one at the bottom, both asking for a click, was the first
   thing a new player saw. */
const TUT_START  = 'First, <b>click anywhere on the field</b> to start the game.';
const TUT_READY  = 'Press the <b>space bar</b> when you are ready.';
const TUT_PRAISE = 'Well done.';
const TUT_PRAISE_T = 3.0;            // seconds the card holds before fading
const TUT_FADE_T   = 0.3;            // and how long the fade itself takes
const TUT_HOLD     = 0.45;           // default beat between satisfying and advancing

/* THE SPIN. Half a turn inside half a second.

   The angular spring settles in 2*zeta/omega = 2*1.6/(2*pi*11) = 46ms, so the
   paddle can follow anything a hand can command and the limit is the wheel, not
   the physics. A coarse notch is 30 degrees, so 180 is six of them: six notches
   in 0.5s is 12 a second, a brisk roll rather than a turn. At 0.2s it would be
   30 a second, which only a free-spinning wheel manages; at 0.8s an ordinary
   adjustment would qualify and the lesson would teach nothing. */
const TUT_SPIN_ARC    = Math.PI;     // radians inside the window
const TUT_SPIN_WINDOW = 0.5;         // seconds
const TUT_SPIN_LOCK   = 0.35;        // one flick counts once, however long it runs on
const TUT_SPINS       = 3;
const TUT_GOALS       = 3;

/* The wheel turns in 30 degree steps. A tolerance under half a fine step keeps
   the neighbours out: at 3.5 degrees, 37.5 and 52.5 both miss. */
const TUT_ANGLE_TOL = 3.5 * Math.PI / 180;

/* A paddle is a rectangle, so it looks the same at a and a+180. Fold the
   commanded angle into [0,180) and both ways up count as the same answer —
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
    hold: 2,
    done: () => tutAngleIs(90),
  },
  {
    text: 'Now try <b>tilting your paddle at an angle</b>. ' +
          'This is often a good angle for hitting the ball.',
    hint: 'tilt it so the face points up the field, toward the goal you are attacking',
    diagram: () => tutTiltDiagram(),
    hold: 2,
    done: () => { const [a, b] = tutTiltAngles(); return tutAngleIs(a) || tutAngleIs(b); },
  },
  {
    text: 'You can also <b>spin your paddle</b> by quickly rolling the mouse wheel. ' +
          'This will help add speed to your shots.',
    hint: 'a flick, not a turn — half a rotation inside half a second',
    count: () => 'Spins completed ' + Math.min(tut.spins, TUT_SPINS) + '/' + TUT_SPINS,
    done: () => tut.spins >= TUT_SPINS,
  },
  {
    kind: 'note',
    text: 'Your job is to <b>score on your opponent</b>.',
    hint: 'press space to continue',
    goals: 'theirs',
  },
  {
    kind: 'note',
    text: 'And to <b>defend your own goal</b>.',
    hint: 'press space to continue',
    goals: 'yours',
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
    text: '<b>During practice mode</b>, you can press <b>F</b> to re-serve the ball. Try it now.',
    hint: 'the ball drops again from the middle, whatever it was doing',
    hold: 0.5,
    praise: false,          // straight on: the next card is the reason for this one
    done: () => tut.serves >= 1,
  },
  {
    /* Red is safe to name because Tab is disabled for the whole tutorial, so
       mySide cannot change and the goal being attacked is always side -1's. */
    text: 'Now try to score <b>3 goals</b> by hitting the ball into the <b>red goal</b>. ' +
          'Remember to <b>rotate your paddle</b> for more accurate shots.',
    hint: 're-serve with F whenever you want the ball back',
    count: () => 'Goals ' + Math.min(tut.goals, TUT_GOALS) + '/' + TUT_GOALS,
    praise: false,          // the finish card opens with the praise instead
    done: () => tut.goals >= TUT_GOALS,
  },
  {
    kind: 'finish',
    text: '<b>Great job!</b> That\'s everything. Now you can continue to practice alone, ' +
          'or try playing against the computer to hone your skills.',
  },
];

function tutStart() {
  tut.active = true;
  tut.step = 0;
  tut.held = 0;
  tutResetCounters();
  /* Quitting part-way leaves the step you were on marked as entered, and its
     enter() would then be skipped next time round — for the hitting step that
     means no ball is ever served. */
  for (const s of STEPS) s.entered = false;
  document.body.classList.add('tutorial');
  tut.phase = 'start';
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
  tut.serves = tut.spins = 0;
  tut.spinBuf.length = 0;
  tut.spinLock = 0;
  tut.activeT = 0;
}

/* The world stands still for anything that is being read, which is everything
   except a task. Asked by the frame loop, which already knows how to hold the
   simulation for a pause. */
function tutHold() { return tut.active && tut.phase !== 'active'; }

// Tab swaps sides in practice, and a tutorial is practice. Halfway through
// being told to aim at the red goal is not the moment for the colours to
// change hands, so it is refused for the duration.
function tutBlocksTab() { return tut.active; }

/* Space starts a brief and dismisses a note. Returns whether it took the key,
   so the ordinary handler can leave it alone — otherwise the same press that
   begins the "press space to switch paddles" step would also switch them. */
function tutSpace() {
  if (!tut.active) return false;
  if (tut.phase === 'brief') {
    tut.phase = 'active';
    tut.held = 0;
    tutResetCounters();
    paintTutorial();
    return true;
  }
  if (tut.phase === 'note') { tutAdvance(); return true; }
  return false;
}

// What kind of card a step opens with.
function tutKindOf(s) { return s && s.kind ? s.kind : 'task'; }

function tutEnterStep() {
  const s = STEPS[tut.step];
  if (!s) return;
  const kind = tutKindOf(s);
  tut.held = 0;
  tut.phase = kind === 'note' ? 'note' : kind === 'finish' ? 'finish' : 'brief';
  /* The finish card has buttons, and a captured pointer cannot click one. The
     lock is released as the card appears rather than when a button is pressed,
     because the player has to be able to reach it. */
  if (kind === 'finish' && document.exitPointerLock) document.exitPointerLock();
  paintTutorial();
}

function paintTutorial() {
  const box = $('tut');
  box.classList.remove('fade');       // a repaint is always something to see
  const ph = tut.phase;
  const start  = ph === 'start';
  const praise = ph === 'praise';
  const brief  = ph === 'brief';
  const finish = ph === 'finish';
  const s = (start || praise) ? null : STEPS[tut.step];
  if (!start && !praise && !s) return;

  $('tutText').innerHTML = start ? TUT_START : praise ? TUT_PRAISE : s.text;
  // innerHTML, not textContent: hints carry <b>.
  $('tutHint').innerHTML = (start || praise) ? '' : (s.hint || '');

  const diagram = (s && s.diagram) ? s.diagram() : '';
  $('tutDiagram').innerHTML = diagram;
  $('tutDiagram').style.display = diagram ? '' : 'none';

  // The running tally only means anything while the thing is being counted.
  const count = (ph === 'active' && s && s.count) ? s.count() : '';
  $('tutCount').textContent = count;
  $('tutCount').style.display = count ? '' : 'none';

  $('tutReady').innerHTML = brief ? TUT_READY : '';
  $('tutReady').style.display = brief ? '' : 'none';

  $('tutButtons').innerHTML = finish
    ? '<button id="tutPractice">PRACTICE</button><button id="tutVsAi">VS AI</button>'
    : '';
  $('tutButtons').style.display = finish ? '' : 'none';
  if (finish) {
    $('tutPractice').addEventListener('click', () => tutFinishTo(false));
    $('tutVsAi').addEventListener('click', () => tutFinishTo(true));
  }

  /* Centred for the cards that are only words; on the top rail for the ones
     with something on the field to look at, whether or not it is moving. */
  const centred = start || brief || praise || finish;
  box.classList.toggle('mid', centred);
  box.classList.toggle('top', !centred);
  box.classList.toggle('act', finish);       // only this one takes clicks

  let dots = '';
  for (let i = 0; i < STEPS.length; i++) {
    dots += '<i class="' + (i === tut.step && !start ? 'on' : i < tut.step ? 'past' : '') + '"></i>';
  }
  $('tutDots').innerHTML = dots;
}

/* Out of the tutorial and into the setup card for the chosen mode. leaveGame
   tears the session down and returns to the menu, so the mode is set after it
   rather than before, or showMenu would clear it again. */
function tutFinishTo(vsAi) {
  tutStop();
  leaveGame();
  net.role = 'solo';
  mySide = 1;
  AI.on = vsAi;
  pendingTutorial = false;
  if (vsAi) aiInit();
  updateStatus();
  showSetup();
}

// Called once per frame, including while the world is held — the tutorial has
// to keep watching in exactly the states where the simulation is not running.
function pumpTutorial(dt) {
  if (!tut.active || !running) return;

  /* Nothing begins until the mouse is captured, and capturing it is the click
     the first card asks for. Polled rather than hooked into the pointer-lock
     handler, which keeps the lock code free of tutorial special cases. */
  if (tut.phase === 'start') {
    if (pointerLocked) tutEnterStep();
    return;
  }

  /* WELL DONE, then out. The card holds, fades over its last moments, and the
     next one is painted as it disappears — so the two never overlap and a new
     instruction arrives on a clean screen. */
  if (tut.phase === 'praise') {
    tut.praiseT += dt;
    if (tut.praiseT > TUT_PRAISE_T - TUT_FADE_T) $('tut').classList.add('fade');
    if (tut.praiseT >= TUT_PRAISE_T) tutAdvance();
    return;
  }

  const s = STEPS[tut.step];
  if (!s) return;
  if (s.skip && s.skip()) { tutAdvance(); return; }
  if (tut.phase !== 'active') return;     // note and finish wait on the player

  if (!s.entered) { s.entered = true; if (s.enter) s.enter(); }
  tut.activeT += dt;
  if (s.count) paintTutorial();           // keep the tally honest

  /* A beat after the predicate holds, so a completed instruction is visibly
     acknowledged rather than vanishing under the player's hands. Some steps
     want longer: an angle should be SETTLED on, not swept through. */
  if (s.done()) {
    tut.held += dt;
    if (tut.held > (s.hold || TUT_HOLD)) tutPraise();
  } else {
    tut.held = 0;
  }
}

/* Every gate earns a WELL DONE unless the step says otherwise — the last two
   do, one because the next card is the whole reason for it and one because the
   finish card opens with the praise itself. */
function tutPraise() {
  if (STEPS[tut.step].praise === false) { tutAdvance(); return; }
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
  tutEnterStep();
}

/* THE TWO GOALS, labelled, while the card that explains them is up.

   Drawn in screen space off the same view mapping the scoreboard uses, so the
   labels sit beside the goals at any zoom without needing the world transform.

   Side +1 scores into x = 0 — checkGoal awards +1 when the ball crosses there —
   so the goal you attack is the one at the far end from the one you defend, and
   both follow mySide rather than being written down. */
function tutGoalMark() {
  const s = STEPS[tut.step];
  if (!tut.active || tut.phase !== 'note' || !s || !s.goals) return null;
  const theirs = s.goals === 'theirs';
  return {
    x: (mySide > 0) === theirs ? 0 : A.width,
    text: theirs ? 'THEIR GOAL — SCORE HERE' : 'YOUR GOAL — DEFEND IT',
  };
}

function drawTutorialGoals(ctx) {
  const m = tutGoalMark();
  if (!m) return;
  const sx = wx => view.ox + wx * view.scale;
  const sy = wy => view.oy - wy * view.scale;
  const midY = (goalY0() + goalY1()) / 2;

  const inward = m.x === 0 ? 1 : -1;              // into the field, whichever end
  const tipX = sx(m.x + inward * 0.25);
  const tipY = sy(midY);
  const labX = sx(m.x + inward * 2.6);
  const labY = sy(goalY1() + 1.6);

  ctx.save();
  ctx.font = `700 ${Math.max(11, Math.round(view.scale * 0.30))}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(1.5, view.scale * 0.035);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';

  ctx.beginPath();
  ctx.moveTo(labX, labY + view.scale * 0.18);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

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
  ctx.restore();
}

/* The counters below are fed from the ordinary input path and from the
   simulation's own event log, so the tutorial observes the game rather than
   instrumenting it. */
function tutOnMove(dx, dy) { if (tut.active) tut.moved += Math.hypot(dx, dy); }

/* A SPIN is a sliding window, not a total. Summing rotation and waiting for
   half a turn would count a slow deliberate turn as a flick, which is the
   opposite of the lesson — so only what happened inside the last window
   counts, and a completed spin is locked out briefly so one long flick cannot
   register three times as it runs on. */
function tutOnTurn(rad, fine) {
  if (!tut.active) return;
  const r = Math.abs(rad);
  tut.turned += r;
  if (fine) tut.fine += r;

  const now = performance.now() / 1000;
  tut.spinBuf.push({ t: now, r });
  while (tut.spinBuf.length && now - tut.spinBuf[0].t > TUT_SPIN_WINDOW) tut.spinBuf.shift();
  if (now < tut.spinLock) return;

  let sum = 0;
  for (const e of tut.spinBuf) sum += e.r;
  if (sum >= TUT_SPIN_ARC) {
    tut.spins++;
    tut.spinBuf.length = 0;
    tut.spinLock = now + TUT_SPIN_LOCK;
  }
}

function tutOnSwitch() { if (tut.active) tut.switched++; }
function tutOnServe()  { if (tut.active) tut.serves++; }
function tutOnEvent(kind) {
  if (!tut.active) return;
  if (kind === 'paddle') tut.hits++;
  if (kind === 'goal') tut.goals++;
}
