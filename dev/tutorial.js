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
  phase: 'start',   // 'start' waiting for the click | 'brief' reading | 'active' doing
  step: 0,
  held: 0,          // seconds the current step has been satisfied
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

const STEPS = [
  {
    text: 'Move your mouse to <b>control your paddle</b>.',
    hint: 'the paddle chases the cursor; the line between them is the pull',
    done: () => tut.moved > 8,
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
  const start = tut.phase === 'start';
  const brief = tut.phase === 'brief';
  const s = start ? null : STEPS[tut.step];
  if (!start && !s) return;

  $('tutText').innerHTML = start ? TUT_START : s.text;
  $('tutHint').textContent = start ? '' : (s.hint || '');
  $('tutReady').innerHTML = brief ? TUT_READY : '';
  $('tutReady').style.display = brief ? '' : 'none';

  // Centred while reading, on the top rail while playing.
  box.classList.toggle('mid', start || brief);
  box.classList.toggle('top', !start && !brief);

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

  const s = STEPS[tut.step];
  if (!s) return;
  if (s.skip && s.skip()) { tutAdvance(); return; }
  if (tut.phase !== 'active') return;     // reading; nothing counts yet

  if (!s.entered) { s.entered = true; if (s.enter) s.enter(); }

  // A beat after the predicate holds, so a completed instruction is visibly
  // acknowledged rather than vanishing under the player's hands.
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
  tut.phase = 'brief';                    // every step is read before it is done
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
