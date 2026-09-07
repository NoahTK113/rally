/* Loaded as a classic script for the same reason as the others: an ES module
   needs CORS, which a page opened from file:// cannot satisfy.

   Like the tutorial, this is a LAYER over the game rather than a mode inside
   it. The simulation has no idea a gauntlet is running; this watches goals go
   by, keeps a level, and moves the AI along a curve. Nothing in stepWorld
   changes. */

/* ==========================================================================
   GAUNTLET

   No score. A level, from 1 upward. Every goal you score moves it up and the
   opponent with it; the first goal it scores ends the run.

   Level 100 is the strongest AI that exists, and beating it is the end of the
   ladder rather than the end of the mode: from there it runs on as survival,
   levels still climbing, difficulty pinned at the top.
   ========================================================================== */
const gaunt = {
  active: false,
  armed: false,     // set before startGame, because the level must be applied
                    // AFTER restoreTuning or the defaults would overwrite it
  level: 1,
  survival: false,
  pending: null,    // 'over' | 'win' — raised inside the step, acted on next frame
  shown: false,     // a panel is up and the run is suspended
  best: 0,
};

const GAUNT_TOP = 100;          // the strongest AI there is

/* THE CURVE.

   Linear would be 11 gauntlet levels per AI level, which puts the first eleven
   rounds below AI level 2 — an opponent with 0.17s reaction, 90% aim error and
   100% positional drift, which barely defends. Twenty rounds of that before it
   becomes interesting is the wrong shape for a survival mode.

   So: AI 1 to 5 across the first 30 levels, then 5 to 10 across the remaining
   70. The early game is short and the late game is the long part.

       level    1     10     20     30     50     75    100
       AI    1.00   2.24   3.62   5.00   6.43   8.21  10.00
*/
function gauntDifficulty(L) {
  if (L >= GAUNT_TOP) return 10;
  if (L <= 30) return 1 + 4 * (L - 1) / 29;
  return 5 + 5 * (L - 30) / 70;
}

// The ladder takes a fraction of itself; the curve decides which fraction.
function gauntApply() { aiSetLevelT((gauntDifficulty(gaunt.level) - 1) / 9); }

/* Kept out of PREFS_KEYS on purpose. A version bump exists to clear settings
   whose MEANING changed, and a high score has no meaning to go stale — losing
   it to an unrelated upgrade would just be a loss. */
function gauntLoadBest() {
  try {
    const v = parseInt(localStorage.getItem('banjoball.best'), 10);
    gaunt.best = (v >= 1) ? v : 0;
  } catch (e) { gaunt.best = 0; }
  return gaunt.best;
}

function gauntSaveBest(L) {
  if (L <= gaunt.best) return;
  gaunt.best = L;
  try { localStorage.setItem('banjoball.best', L); } catch (e) {}
}

function gauntStart() {
  gaunt.active = true;
  gaunt.armed = false;
  gaunt.level = 1;
  gaunt.survival = false;
  gaunt.pending = null;
  gaunt.shown = false;
  gauntLoadBest();
  gauntApply();
}

function gauntStop() {
  gaunt.active = false;
  gaunt.armed = false;
  gaunt.pending = null;
  gaunt.shown = false;
}

// Whether a gauntlet panel is up. resumeGame refuses while it is, or Escape
// would put the player back on the field with the run already decided.
function gauntShown() { return gaunt.active && gaunt.shown; }

/* A goal, straight from award(). Only a flag is set: award runs inside
   stepWorld, and opening a menu from inside the simulation step would mean the
   world changing under a card that had already been drawn. */
function gauntOnGoal(side) {
  if (!gaunt.active || gaunt.shown || gaunt.pending) return;
  if (side !== mySide) { gaunt.pending = 'over'; return; }

  // The top of the ladder is a card, once. After that the levels run on.
  if (gaunt.level >= GAUNT_TOP && !gaunt.survival) { gaunt.pending = 'win'; return; }

  gaunt.level++;
  gauntSaveBest(gaunt.level);
  gauntApply();
}

/* Raising the card is a frame-loop job, next to the tutorial's. Releasing the
   pointer is what makes the buttons clickable and also pauses the game on its
   own, since the lock-loss handler treats a lost lock as a pause — so both
   calls are made and whichever lands first, the other is a no-op. */
function pumpGauntlet(dt) {
  if (!gaunt.active || !gaunt.pending || gaunt.shown) return;
  const which = gaunt.pending;
  gaunt.pending = null;
  gaunt.shown = true;

  if (which === 'over') {
    gauntSaveBest(gaunt.level);
    $('gauntOverLevel').textContent = 'You reached level ' + gaunt.level + '.';
    $('gauntOverBest').textContent =
      gaunt.best ? 'Best: level ' + gaunt.best : '';
  }

  if (document.exitPointerLock) document.exitPointerLock();
  openPause();
  pausePanel(which === 'over' ? 'gauntover' : 'gauntwin');
}

/* Past the top. The difficulty is already pinned by gauntDifficulty, so
   nothing about the opponent changes from here — only how long you last. */
function gauntContinueSurvival() {
  gaunt.survival = true;
  gaunt.level++;
  gauntSaveBest(gaunt.level);
  gauntApply();
  gaunt.shown = false;
  resumeGame();
}

/* Set the mode, then start. The level cannot be applied until startGame has
   run restoreTuning, which resets AI and SHOT to their defaults — hence
   `armed` rather than calling gauntStart from here. */
function gauntBegin() {
  net.role = 'solo';
  mySide = 1;
  AI.on = true;
  MATCH.paddles = 1;          // the AI never writes `sel`; a second paddle would stand still
  pendingTutorial = false;
  pendingGauntlet = false;
  aiInit();
  updateStatus();
  gaunt.armed = true;
  startGame();
}

function gauntRestart() {
  gaunt.shown = false;
  paused = false;
  document.body.classList.remove('paused');
  gauntStop();
  leaveGame();
  gauntBegin();
}

function gauntQuit() {
  gaunt.shown = false;
  paused = false;
  document.body.classList.remove('paused');
  gauntStop();
  leaveGame();
}

/* The scoreboard, replaced. There is no score in a gauntlet — the level is the
   score — so this draws in its place rather than beside it. */
function drawGauntletHud(ctx, sx, sy, size) {
  ctx.textAlign = 'center';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('LEVEL ' + gaunt.level, sx, sy);

  if (!gaunt.survival) return;
  ctx.font = `600 ${Math.max(9, Math.round(size * 0.28))}px ui-monospace, Consolas, monospace`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('SURVIVAL MODE — MAXIMUM DIFFICULTY REACHED', sx, sy + size * 0.72);
}

// What the banner says when a goal goes in: the level you just reached, not
// which team scored. There is only one team that can.
function gauntAnnounce() {
  if (!gaunt.active) return null;
  return 'LEVEL ' + gaunt.level;
}
