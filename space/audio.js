/* Classic script, not a module — see tutorial.js for why.

   pumpEvents() deliberately stays in index.html: it walks the simulation's
   event log and feeds both this file and the tutorial, so it belongs to
   neither. Everything here is downstream of that call. */

/* ==========================================================================
   SOUND

   Drop a file into sounds/ and it replaces the placeholder for that event —
   the names below are the whole wiring. Any extension the browser can decode
   works; .wav and .mp3 both do.

   Two things make this less trivial than it looks.

   Loading only works over http(s). A page opened from file:// treats every
   local file as a separate origin and cannot fetch its own siblings, so local
   testing falls back to the synthesised placeholders. On the deployed URL the
   files load normally.

   And the client re-simulates the last several ticks on every snapshot, so
   anything that played a sound at the moment of collision would replay it
   several times per hit. Instead the simulation RECORDS events with an id,
   and this layer plays only ids it has not seen. Rollback then dedupes for
   free: a replayed collision regenerates the same id and is skipped.
   ========================================================================== */
const SOUNDS = {
  paddle:    'sounds/paddle.wav',
  wall:      'sounds/wall.wav',
  net:       'sounds/net.wav',
  scored:    'sounds/scored.wav',      // you put it in their goal
  conceded:  'sounds/conceded.wav',    // they put it in yours
  count:     'sounds/count.wav',       // each number of the countdown
  go:        'sounds/go.wav',          // zero
};

const AUDIO = { vol: 0.7 };

const audio = {
  ctx: null,
  master: null,
  buffers: {},          // kind -> AudioBuffer, or null while missing
  started: false,
};

/* Browsers refuse to start audio without a user gesture. The click that
   captures the mouse is one, so there is no separate "click to enable". */
function audioStart() {
  if (audio.started) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audio.started = true;
  audio.ctx = new Ctx();
  audio.master = audio.ctx.createGain();
  audio.master.gain.value = AUDIO.vol;
  audio.master.connect(audio.ctx.destination);

  for (const kind in SOUNDS) {
    audio.buffers[kind] = null;
    // Versioned so a redeploy is never served a stale file from cache. A hard
    // refresh reloads the page but does not reliably clear things fetched by
    // script afterwards, which makes "did my new sound deploy" unanswerable.
    fetch(SOUNDS[kind] + '?v=' + encodeURIComponent(BUILD))
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
      .then(buf => audio.ctx.decodeAudioData(buf))
      .then(decoded => { audio.buffers[kind] = decoded; })
      .catch(() => {});          // absent or unreachable: keep the placeholder
  }
}

function setVolume(v) {
  AUDIO.vol = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
  if (audio.master) audio.master.gain.value = AUDIO.vol;
  // Read back as banjoball.vol; the old flickball key was left behind by the
  // rename, so volume silently failed to persist at all.
  try { localStorage.setItem('banjoball.vol', AUDIO.vol); } catch (e) {}
  paintVolume();
}

// Position across the court maps to the stereo field, which makes a hit on the
// far side legible without looking at it.
function panFor(x) {
  const t = (x / A.width) * 2 - 1;
  return Math.max(-1, Math.min(1, t)) * 0.7;
}

function playSample(kind, gain, rate, x) {
  const src = audio.ctx.createBufferSource();
  src.buffer = audio.buffers[kind];
  src.playbackRate.value = rate;
  const g = audio.ctx.createGain();
  g.gain.value = gain;
  const pan = audio.ctx.createStereoPanner
    ? audio.ctx.createStereoPanner() : null;
  if (pan) { pan.pan.value = panFor(x); src.connect(g); g.connect(pan); pan.connect(audio.master); }
  else { src.connect(g); g.connect(audio.master); }
  src.start();
}

/* Placeholders. Deliberately plain: they exist so the timing and the mix can
   be judged before any recording exists, not to be kept. */
function playSynth(kind, gain, mag, x) {
  const c = audio.ctx, t = c.currentTime;
  const g = c.createGain();
  const pan = c.createStereoPanner ? c.createStereoPanner() : null;
  if (pan) { pan.pan.value = panFor(x); g.connect(pan); pan.connect(audio.master); }
  else g.connect(audio.master);

  if (kind === 'wall' || kind === 'net') {
    // a short filtered noise burst
    const n = c.createBufferSource();
    const len = Math.floor(c.sampleRate * 0.08);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    n.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = kind === 'net' ? 900 : 380;
    f.Q.value = kind === 'net' ? 4 : 1.4;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    n.connect(f); f.connect(g);
    n.start(t); n.stop(t + 0.1);
    return;
  }

  const o = c.createOscillator();

  if (kind === 'count' || kind === 'go') {
    // A plain sine; zero is a perfect fifth above the numbers, so the release
    // is audible as a resolution rather than just another beep.
    o.type = 'sine';
    o.frequency.value = kind === 'go' ? 660 : 440;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * 0.85, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'go' ? 0.45 : 0.21));
    o.connect(g);
    o.start(t); o.stop(t + (kind === 'go' ? 0.51 : 0.27));
    return;
  }

  if (kind === 'scored' || kind === 'conceded') {
    // rising for yours, falling for theirs — legible before you read the score
    const up = kind === 'scored';
    o.type = 'triangle';
    o.frequency.setValueAtTime(up ? 180 : 460, t);
    o.frequency.exponentialRampToValueAtTime(up ? 520 : 130, t + 0.28);
    g.gain.setValueAtTime(gain * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(g); o.start(t); o.stop(t + 0.6);
  } else {
    // paddle: a click that rises in pitch with how hard it was struck
    o.type = 'square';
    const f0 = 220 + Math.min(1, mag / 12) * 520;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.07);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(g); o.start(t); o.stop(t + 0.12);
  }
}

function playEvent(e) {
  if (!audio.ctx || AUDIO.vol <= 0) return;
  if (audio.ctx.state === 'suspended') audio.ctx.resume();

  // A goal is one event in the simulation. Which of the two it sounds like is
  // decided here, per listener, because 'scored' and 'conceded' describe the
  // person hearing it rather than anything the world knows about.
  const kind = e.kind === 'goal'
    ? (e.side === mySide ? 'scored' : 'conceded')
    : e.kind;

  const fixed = kind === 'scored' || kind === 'conceded' ||
                kind === 'count' || kind === 'go';
  const norm = Math.min(1, e.mag / 10);
  const gain = fixed ? 0.9 : 0.12 + norm * 0.88;
  const rate = fixed ? 1 : 0.9 + norm * 0.3;

  if (audio.buffers[kind]) playSample(kind, gain, rate, e.x);
  else playSynth(kind, gain, e.mag, e.x);
}
