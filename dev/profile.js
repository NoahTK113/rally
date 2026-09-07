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
const PASSWORD_MIN = 8;

let sb = null;                               // the client, or null if unavailable
let authChecked = false;                     // the session question has been answered
const acct = { id: null, username: null, best: 0 };

function authReady()   { return !!sb; }
function authIsChecked() { return authChecked; }

/* Stop waiting. Called by a timeout at startup, because a hanging network must
   not leave someone staring at a door that never opens. */
function authGiveUp() { authChecked = true; }
function signedIn()   { return !!acct.id; }
function authName()   { return acct.username; }
function authBest()   { return acct.best; }

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
    acct.id = null; acct.username = null; acct.best = 0;
    paintAccount();
    return;
  }
  acct.id = session.user.id;
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
    return { u: null, err: 'Username: 3 to 20 characters, lowercase letters, numbers, - or _' };
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

  const { error } = await sb.auth.signUp({
    email: v.u + '@banjoball.invalid',
    password: password,
    options: { data: { username: v.u } },
  });
  if (error) {
    // The address is an implementation detail; do not leak it into the message.
    if (/already registered|already exists/i.test(error.message)) {
      return 'That username is taken.';
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
    if (/invalid login/i.test(error.message)) return 'Wrong username or password.';
    return error.message;
  }
  return null;
}

async function authSignOut() {
  if (!sb) return;
  try { await sb.auth.signOut(); } catch (e) {}
  authAdopt(null);
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
