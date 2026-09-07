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
  cheated: false,   // the level was set by hand, so the high score must not learn from it
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

/* The record comes from the PROFILE, not from this machine. It briefly lived
   in localStorage, which made it the single easiest thing in the game to cheat
   - one line in the console, no code to read. There is now nothing local to
   edit: the server owns the number and the client is only told it.

   So this reads rather than loads. A guest, or anyone offline, has no record
   because there is nowhere to keep one. */
function gauntBest() { return signedIn() ? authBest() : 0; }

/* Kept for the shape of the call site until runs report to the server; the
   record is written by record_goal in the database, never here. */
function gauntSaveBest(L) {
  if (gaunt.cheated) return;
  if (L > gaunt.best) gaunt.best = L;
}

/* Whether this run may claim the leaderboard. Being signed in is necessary and
   not sufficient: an unlocked developer session has a slider that moves the
   level directly, so it is disqualified before it starts rather than caught
   afterwards. */
function gauntEligible() {
  return authReady() && signedIn() && !devUnlocked;
}

function gauntStart() {
  gaunt.active = true;
  gaunt.armed = false;
  gaunt.level = 1;
  gaunt.survival = false;
  gaunt.pending = null;
  gaunt.shown = false;
  gaunt.cheated = false;
  gaunt.best = gauntBest();
  gauntApply();
  runStart(gauntEligible());
}

function gauntStop() {
  if (gaunt.active) runEnd();     // idempotent; a closed run closes once
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
  syncPanel();       // the developer slider reads gaunt.level; keep it honest

  /* The server keeps its own count and is not asked what it thinks. Displaying
     its answer would make every level-up wait for a round trip, and the two
     cannot disagree in honest play - if they ever do, the reply fails and the
     run stops being ranked, which is the outcome that matters. */
  runGoal();
}

/* The developer slider writes gaunt.level directly, so the opponent has to be
   moved to match. Outside a run there is nothing to move and gauntStart resets
   the level to 1 anyway, so it does nothing there rather than quietly
   redefining the difficulty of a VS AI match. */
function gauntSetLevelManually() {
  gaunt.level = Math.max(1, Math.round(gaunt.level));
  if (!gaunt.active) return;
  gaunt.cheated = true;
  runDisqualify();          // the run may continue; its record may not
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
    runEnd();
    gauntSaveBest(gaunt.level);
    $('gauntOverLevel').textContent = 'You reached level ' + gaunt.level + '.';
    $('gauntOverBest').textContent =
      !signedIn()  ? 'Sign in to record a best.'
      : gaunt.best ? 'Best: level ' + gaunt.best
      : '';
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

  /* One subtitle slot, and survival outranks it: a run at the top of the
     ladder has earned the more interesting label. Otherwise say plainly that
     nothing is being recorded, rather than letting someone find out at the
     end. */
  const sub = gaunt.survival ? 'SURVIVAL MODE — MAXIMUM DIFFICULTY REACHED'
            : runRanked()    ? ''
                             : 'UNRANKED';
  if (!sub) return;
  ctx.font = `600 ${Math.max(9, Math.round(size * 0.28))}px ui-monospace, Consolas, monospace`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(sub, sx, sy + size * 0.72);
}

/* What the banner says when YOU score: the level you just reached, rather than
   which team scored.

   Only when you score. lastScorer is 0 for a dead ball and -mySide when the AI
   scores, and neither of those is a level change - a dead ball reads DEAD BALL
   here exactly as it does in every other mode, because it means the same thing
   in all of them. Claiming the banner for every announcement was the bug. */
function gauntAnnounce() {
  if (!gaunt.active) return null;
  if (world.lastScorer !== mySide) return null;
  return 'LEVEL ' + gaunt.level;
}
