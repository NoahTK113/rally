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

   Adding a step is one entry in STEPS. Nothing else needs to change.
   ========================================================================== */
const tut = {
  active: false,
  step: 0,
  held: 0,          // seconds the current step has been satisfied
  moved: 0,         // metres the held paddle has travelled
  turned: 0,        // radians of commanded rotation
  fine: 0,          // radians commanded while the fine modifier was held
  switched: 0,      // paddle handoffs
  hits: 0,          // paddle contacts with the ball
  goals: 0,
};

const STEPS = [
  {
    text: '<b>Click</b> anywhere to capture your mouse.',
    hint: 'nothing responds until you do — press escape to release it again',
    done: () => pointerLocked,
  },
  {
    text: 'Move the mouse to <b>steer your paddle</b>.',
    hint: 'the paddle chases the cursor; the line between them is the pull',
    done: () => tut.moved > 6,
  },
  {
    text: '<b>Roll the mouse wheel</b> to turn the paddle.',
    hint: 'it turns in fixed steps, so flat and upright are always reachable',
    done: () => tut.turned > Math.PI * 1.5,
  },
  {
    text: 'Hold <b>right-click</b> and roll the wheel for finer turns.',
    hint: 'smaller steps, for angles the coarse ones skip',
    done: () => tut.fine > Math.PI * 0.4,
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
  tut.step = 0;
  tut.held = tut.moved = tut.turned = tut.fine = 0;
  tut.switched = tut.hits = tut.goals = 0;
  document.body.classList.add('tutorial');
  paintTutorial();
}

function tutStop() {
  tut.active = false;
  document.body.classList.remove('tutorial');
}

function paintTutorial() {
  const s = STEPS[tut.step];
  if (!s) return;
  $('tutText').innerHTML = s.text;
  $('tutHint').textContent = s.hint || '';
  let dots = '';
  for (let i = 0; i < STEPS.length; i++) {
    dots += '<i class="' + (i === tut.step ? 'on' : i < tut.step ? 'past' : '') + '"></i>';
  }
  $('tutDots').innerHTML = dots;
}

// Called once per frame. Advances when the current step's predicate holds, with
// a beat in between so a completed instruction is visibly acknowledged rather
// than vanishing under the player's hands.
function pumpTutorial(dt) {
  if (!tut.active || !running) return;

  const s = STEPS[tut.step];
  if (!s) return;

  if (s.skip && s.skip()) { tutAdvance(); return; }
  if (!s.entered) { s.entered = true; if (s.enter) s.enter(); }

  if (s.done()) {
    tut.held += dt;
    if (tut.held > 0.45) tutAdvance();
  } else {
    tut.held = 0;
  }
}

function tutAdvance() {
  STEPS[tut.step].entered = false;
  tut.step++;
  tut.held = 0;
  if (tut.step >= STEPS.length) { tutStop(); leaveGame(); return; }
  paintTutorial();
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
