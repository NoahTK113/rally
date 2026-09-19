/* Loaded as a classic script like the rest, so it shares the one global scope.

   THE ACCOUNT LAYER.

   Everything here is optional. The game runs with no network, from file://,
   with this file failing to load its library entirely - and a player who never
   signs in loses nothing but the leaderboard. So every entry point checks
   whether there is a client at all before doing anything, and nothing in the
   game waits on a reply.

   Usernames, not emails. Supabase Auth only understands email addresses, so a
   username becomes <username>@banjoball.invalid on the way in - .invalid is a
   reserved suffix that can never resolve, so a typo cannot mail a stranger.
   The player never sees it. The profiles table stores the username itself, and
   that is what the leaderboard shows.

   The cost of that choice is no password reset, since there is nowhere to send
   one. Deliberate for now: a forgotten password is a dashboard reset.
   ========================================================================== */

/* Public by design. The anon key is protected by row-level security rather
   than secrecy - it is in the source of every Supabase site there is. The
   SECRET key is a different string and must never appear here. */
const SB_URL = 'https://rpdyrkdudakfejbxzsdx.supabase.co';
const SB_KEY = 'sb_publishable_9c4VMTyp2gDJkVLuRk3bqw_W8NILMVE';

const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;   // must survive becoming an address
const GUEST_RE = /^guest[0-9]+$/;           // handed out by the database, never chosen
const PASSWORD_MIN = 8;

let sb = null;                               // the client, or null if unavailable
let authChecked = false;                     // the session question has been answered
const acct = { id: null, username: null, best: 0, guest: false };

function authReady()   { return !!sb; }
function authIsChecked() { return authChecked; }

/* Stop waiting. Called by a timeout at startup, because a hanging network must
   not leave someone staring at a door that never opens. */
function authGiveUp() { authChecked = true; }
function signedIn()   { return !!acct.id; }
function authName()   { return acct.username; }
function authBest()   { return acct.best; }
function authIsGuest() { return acct.guest; }

/* Whether the player has CHOSEN a name. Every account has a username - a guest
   is given guestN - but that one is a placeholder, reserved so it can never be
   picked, and it is what keeps an unnamed guest off the leaderboard. */
function authHasName() { return !!acct.username && !GUEST_RE.test(acct.username); }

/* The library comes from a CDN, so it is absent offline and absent from
   file:// with no connection. That is not an error worth reporting - it is the
   ordinary case for someone playing on a train - so it just means no account
   layer this session. */
function authInit() {
  try {
    if (typeof supabase === 'undefined' || !supabase.createClient) { authChecked = true; return; }
    sb = supabase.createClient(SB_URL, SB_KEY);
  } catch (e) { sb = null; authChecked = true; return; }

  sb.auth.onAuthStateChange((_ev, session) => authAdopt(session));
  sb.auth.getSession()
    .then(r => { authChecked = true; authAdopt(r.data && r.data.session); })
    .catch(() => { authChecked = true; paintAccount(); });
}

/* A session arrived, or went away. The username and best level live in the
   profiles row rather than the token, so they are fetched rather than decoded. */
function authAdopt(session) {
  authChecked = true;
  if (!session || !session.user) {
    acct.id = null; acct.username = null; acct.best = 0; acct.guest = false;
    paintAccount();
    return;
  }
  acct.id = session.user.id;
  acct.guest = !!session.user.is_anonymous;
  paintAccount();                       // show something immediately
  authRefreshProfile();
}

function authRefreshProfile() {
  if (!sb || !acct.id) return Promise.resolve();
  return sb.from('profiles').select('username,best_level').eq('id', acct.id).single()
    .then(r => {
      if (r.error || !r.data) return;
      acct.username = r.data.username;
      acct.best = r.data.best_level | 0;
      paintAccount();
    })
    .catch(() => {});
}

/* Both of these answer with an error STRING or null, rather than throwing or
   returning a result object - the caller is a form, and all a form wants to
   know is what to put in red under the fields. */
function authValidate(username, password) {
  const u = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    return { u: null, err: 'Name: 3 to 20 characters, lowercase letters, numbers, - or _' };
  }
  if (String(password || '').length < PASSWORD_MIN) {
    return { u: null, err: 'Password must be at least ' + PASSWORD_MIN + ' characters.' };
  }
  return { u: u, err: null };
}

async function authSignUp(username, password) {
  if (!sb) return 'No connection. You can still play as a guest.';
  const v = authValidate(username, password);
  if (v.err) return v.err;
  if (GUEST_RE.test(v.u)) return 'Names like guest12 are kept for guests.';

  const { error } = await sb.auth.signUp({
    email: v.u + '@banjoball.invalid',
    password: password,
    options: { data: { username: v.u } },
  });
  if (error) {
    // The address is an implementation detail; do not leak it into the message.
    if (/already registered|already exists|database error/i.test(error.message)) {
      return 'That name is taken.';
    }
    return error.message;
  }
  return null;
}

async function authSignIn(username, password) {
  if (!sb) return 'No connection. You can still play as a guest.';
  const v = authValidate(username, password);
  if (v.err) return v.err;

  const { error } = await sb.auth.signInWithPassword({
    email: v.u + '@banjoball.invalid',
    password: password,
  });
  if (error) {
    if (/invalid login/i.test(error.message)) return 'Wrong name or password.';
    return error.message;
  }
  return null;
}

/* A GUEST is a real account with no name or password of its own: Supabase's
   anonymous sign-in. The database trigger gives it the next guestN, so it has a
   profile, a best level and a place on the leaderboard like anyone else.

   Its session lives in this browser's storage and nowhere else. Clear that and
   the account is still in the database, but nothing can ever sign into it
   again - which is the deal a guest is offered. */
async function authGuest() {
  if (!sb) return 'No connection. You can play, but scores will not be saved.';
  const { data, error } = await sb.auth.signInAnonymously();
  // Adopted here rather than left to the auth listener, so the caller can act
  // on the new account the moment this resolves.
  if (!error && data && data.session) authAdopt(data.session);
  if (error) {
    if (/anonymous sign-ins are disabled/i.test(error.message)) {
      return 'Guest play is not switched on yet.';
    }
    return error.message;
  }
  return null;
}

/* A guest becomes a real account IN PLACE: same id, so the same profile, the
   same best level and the same run history. Supabase links an email and a
   password to the anonymous user, and a database trigger swaps guestN for the
   username the moment the account stops being anonymous - in the same
   transaction, so a taken name refuses the whole thing rather than leaving an
   account with a login and the wrong name.

   The session is refreshed afterwards because the token still says anonymous
   until it is reissued, and the menu reads that flag. */
async function authUpgrade(username, password) {
  if (!sb || !signedIn()) return 'No connection.';
  if (!acct.guest) return 'You already have an account.';
  const v = authValidate(username, password);
  if (v.err) return v.err;
  if (GUEST_RE.test(v.u)) return 'Names like guest12 are kept for guests.';

  const { error } = await sb.auth.updateUser({
    email: v.u + '@banjoball.invalid',
    password: password,
  });
  if (error) {
    if (/already.*registered|already exists|database error/i.test(error.message)) {
      return 'That name is taken.';
    }
    return error.message;
  }

  try {
    const r = await sb.auth.refreshSession();
    const s = r.data && r.data.session;
    if (s && s.user && s.user.is_anonymous) return 'The account was not finished. Try again.';
    authAdopt(s);
  } catch (e) {}
  return null;
}

/* The first click on the main menu makes the account, whichever button it is.
   It waits for the stored session to be looked up first - the lookup takes a
   moment at load, and a click inside that moment would otherwise make a second
   guest for someone who already has one.

   Never throws and never refuses. With no connection, or guests switched off
   in the dashboard, the game still plays; only the records are lost. */
function authWaitChecked() {
  return new Promise(done => {
    const t0 = Date.now();
    (function poll() {
      if (authIsChecked() || Date.now() - t0 > 4000) done();
      else setTimeout(poll, 50);
    })();
  });
}

async function authEnsure() {
  await authWaitChecked();
  if (!authReady() || signedIn()) return;
  try { await authGuest(); } catch (e) {}
}

/* A name with no password. First come, first served: names are unique, and
   the database says so rather than this checking first, which could only ever
   be a guess about a moment that has already passed.

   Only before stats are saved. Once saved the name is also what you log in
   with, and renaming it would change a login from underneath its owner. */
async function authSetName(name) {
  if (!sb || !signedIn()) return 'No connection.';
  const u = String(name || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return 'Name: 3 to 20 characters, lowercase letters, numbers, - or _';
  if (GUEST_RE.test(u)) return 'Names like guest12 are kept for guests.';

  const { error } = await sb.rpc('set_name', { p_name: u });
  if (error) {
    if (/taken/i.test(error.message)) return 'That name is taken.';
    if (/cannot be changed/i.test(error.message)) return 'A saved name cannot be changed.';
    return error.message;
  }
  await authRefreshProfile();
  return null;
}

async function authSignOut() {
  if (!sb) return;
  try { await sb.auth.signOut(); } catch (e) {}
  authAdopt(null);
}

/* ==========================================================================
   RUNS

   The client does not report a score. It opens a run, says "I scored" as it
   goes, and is told what level it is now on. There is no number to forge,
   because it never sends one.

   Every call is fire-and-forget from the game's point of view: a goal is
   worth the same whether or not the reply arrives, and nothing waits.

   One failure ends the ranking for that run, permanently. Not out of
   strictness - a run that goes quiet for thirty seconds and comes back leaves
   a gap the six-second rule cannot judge, and a record that might be wrong is
   worse than no record. The run continues; only its claim to the leaderboard
   stops.
   ========================================================================== */
const run = { id: null, ranked: false, level: 0 };

function runRanked() { return !!run.id && run.ranked; }

/* `eligible` is the caller's business, not ours: it knows about developer
   unlocks and level sliders, and this knows about the network. */
async function runStart(eligible) {
  run.id = null; run.ranked = false; run.level = 0;
  if (!sb || !signedIn() || !eligible) return;
  try {
    const r = await sb.rpc('start_run');
    if (r.error || !r.data) return;
    run.id = r.data; run.ranked = true; run.level = 1;
  } catch (e) { run.id = null; run.ranked = false; }
}

async function runGoal() {
  if (!runRanked()) return;
  try {
    const r = await sb.rpc('record_goal', { p_run: run.id });
    if (r.error || r.data == null) { run.ranked = false; return; }
    run.level = r.data;
  } catch (e) { run.ranked = false; }
}

/* Stop claiming the leaderboard without stopping the run. Called when the
   player does something the record cannot honestly include. */
function runDisqualify() { run.ranked = false; }

async function runEnd() {
  const id = run.id;
  run.id = null; run.ranked = false;
  if (!sb || !id) return;
  try { await sb.rpc('end_run', { p_run: id }); } catch (e) {}
  authRefreshProfile();          // the best may have moved
}


/* ==========================================================================
   EVENTS

   What people actually do, which is otherwise invisible: the profiles table
   says somebody arrived and the runs table says they played a gauntlet, and
   between those two is everything that has to be guessed at - whether they
   tried the tutorial, whether they finished it, which mode they opened, how
   long they stayed.

   Fire and forget, like the run calls, and silent on every failure. A player
   whose network drops loses a row from a report; nothing they can see is
   affected, and nothing waits on the reply.

   Only for people who are signed in, which since guest accounts is everyone
   who has got past the door. Rows are written by a SECURITY DEFINER function
   and cannot be read back by the client at all.
   ========================================================================== */
function evLog(kind, mode, secs, n) {
  if (!sb || !signedIn()) return;
  try {
    sb.rpc('log_event', {
      p_kind: kind,
      p_mode: mode || '',
      p_secs: Math.max(0, Math.round(secs || 0)),
      p_n: Math.max(0, Math.round(n || 0)),
    }).then(() => {}, () => {});
  } catch (e) {}
}

/* The top hundred, for whenever there is somewhere to show it. Resolves to an
   array, empty on any failure - a leaderboard that cannot be fetched is an
   empty leaderboard, not an error dialog over a game. */
function lbFetch() {
  if (!sb) return Promise.resolve([]);
  return sb.from('leaderboard').select('username,best_level')
    .then(r => (r.error || !r.data) ? [] : r.data)
    .catch(() => []);
}
