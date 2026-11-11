// WoW Trivia – host-authoritative quiz over Supabase Realtime (Broadcast + Presence).
// No build step. Supabase is imported lazily, so Solo mode never touches the network.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* ====================================================================
   Pure game logic (also used by the tests; no DOM access here)
   ==================================================================== */
export const QUESTION_MS = 20000;
export const GRACE_MS = 800;       // network tolerance after the visible timer ends
export const REVEAL_MS = 6000;     // reveal -> scoreboard
export const BOARD_AUTO_MS = 6000; // scoreboard -> next question (auto-advance)
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
export const SOLO_COUNT = 15;
export const DIFF_MULT = { 1: 1, 2: 1.5, 3: 2 };
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0 O 1 I
export const AVATARS = ['🧙', '🧝', '🧛', '🧟', '🧜', '🐉', '🐺', '🦅', '🐻', '🗡️', '🛡️', '🔮'];

export function speedFactor(t) {
  if (t <= 3) return 1;
  if (t >= 20) return 0;
  return 1 - (t - 3) / 17;
}
export function scoreFor(difficulty, t, correct) {
  if (!correct) return 0;
  return Math.round(100 * DIFF_MULT[difficulty] * (1 + 0.5 * speedFactor(t)));
}
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Unique questions, easier first, harder last.
export function pickQuestions(pool, n, rng = Math.random) {
  const n3 = Math.max(1, Math.round(n * 0.2));
  const n1 = Math.round(n * 0.4);
  const n2 = n - n1 - n3;
  const tier = (d) => shuffle(pool.filter((q) => q.difficulty === d), rng);
  const t1 = tier(1), t2 = tier(2), t3 = tier(3);
  const chosen = [...t1.slice(0, n1), ...t2.slice(0, n2), ...t3.slice(0, n3)];
  if (chosen.length < n) { // top up from whatever is left
    const used = new Set(chosen.map((q) => q.id));
    chosen.push(...shuffle(pool.filter((q) => !used.has(q.id)), rng).slice(0, n - chosen.length));
  }
  return chosen.map((q, i) => [q, i]).sort((a, b) => a[0].difficulty - b[0].difficulty || a[1] - b[1]).map((x) => x[0]);
}
export function makeCode(rng = Math.random) {
  let c = '';
  for (let i = 0; i < 5; i++) c += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return c;
}
// id -> 0-based rank; ties keep join order
export function rankMap(players, scoreOf) {
  const sorted = players.map((p, i) => [p, i]).sort((a, b) => scoreOf(b[0]) - scoreOf(a[0]) || a[1] - b[1]);
  const m = {};
  sorted.forEach(([p], i) => { m[p.id] = i; });
  return m;
}
export function cleanName(n) {
  return String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) || 'Hero';
}

export function newState({ code, hostId, settings }) {
  return {
    code, hostId, phase: 'lobby',
    settings: { count: 10, auto: false, hostPlays: true, ...settings },
    players: [], scores: {}, order: [], qi: -1,
    perm: [0, 1, 2, 3], answers: {}, gains: {}, correct: -1,
    sentAt: 0, deadlineAt: 0, autoAt: 0,
    seq: Date.now(), savedAt: 0,
  };
}

// The authority. Lives in the host's browser (or locally in Solo). Time-driven via tick().
export class Engine {
  constructor({ pool, state, solo = false, emit = () => {}, getOnline = () => null, save = () => {}, now = () => Date.now() }) {
    this.pool = pool;
    this.byId = Object.fromEntries(pool.map((q) => [q.id, q]));
    this.s = state;
    this.solo = solo;
    this.emit = emit;
    this.getOnline = getOnline;
    this.save = save;
    this.now = now;
  }
  isPlayer(id) { return this.s.players.some((p) => p.id === id); }
  addPlayer(id, name, avatar) {
    const s = this.s;
    const ex = s.players.find((p) => p.id === id);
    if (ex) { ex.name = name; ex.avatar = avatar; return 'ok'; }
    if (!this.solo && s.players.length >= MAX_PLAYERS) return 'full';
    s.players.push({ id, name, avatar });
    if (!(id in s.scores)) s.scores[id] = 0;
    return 'ok';
  }
  dropOffline(online) {
    if (this.s.phase !== 'lobby') return;
    this.s.players = this.s.players.filter((p) => online.has(p.id));
  }
  setSettings(p) {
    const s = this.s;
    if (p.count && s.phase === 'lobby') s.settings.count = p.count;
    if (typeof p.auto === 'boolean') {
      s.settings.auto = p.auto;
      if (s.phase === 'board') s.autoAt = p.auto ? this.now() + BOARD_AUTO_MS : 0;
    }
    this.pub();
  }
  canStart() {
    const n = this.s.players.length;
    return this.s.phase === 'lobby' && n >= (this.solo ? 1 : MIN_PLAYERS) && n <= MAX_PLAYERS;
  }
  start() {
    if (!this.canStart()) return false;
    const s = this.s;
    s.order = pickQuestions(this.pool, this.solo ? SOLO_COUNT : s.settings.count).map((q) => q.id);
    s.scores = {};
    s.players.forEach((p) => { s.scores[p.id] = 0; });
    s.qi = 0;
    this.startQuestion();
    return true;
  }
  startQuestion() {
    const s = this.s, now = this.now();
    s.perm = shuffle([0, 1, 2, 3]);
    s.answers = {}; s.gains = {}; s.correct = -1;
    s.phase = 'question'; s.sentAt = now; s.deadlineAt = now + QUESTION_MS; s.autoAt = 0;
    this.pub();
  }
  // Host-side receipt time decides the speed bonus. One answer per player per question.
  answer(pid, qi, choice) {
    const s = this.s, now = this.now();
    if (s.phase !== 'question' || qi !== s.qi) return false;
    if (!this.isPlayer(pid) || s.answers[pid]) return false;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return false;
    if (now > s.deadlineAt + GRACE_MS) return false;
    s.answers[pid] = { choice, t: Math.min(QUESTION_MS / 1000, Math.max(0, (now - s.sentAt) / 1000)) };
    if (this.allAnswered()) this.endQuestion(); else this.pub();
    return true;
  }
  allAnswered() {
    const s = this.s, online = this.getOnline();
    const expected = s.players.filter((p) => !online || online.has(p.id));
    return expected.length > 0 && expected.every((p) => s.answers[p.id]);
  }
  endQuestion() {
    const s = this.s;
    if (s.phase !== 'question') return;
    const q = this.byId[s.order[s.qi]];
    s.correct = s.perm.indexOf(q.correct);
    s.players.forEach((p) => {
      const a = s.answers[p.id];
      const ok = !!a && a.choice === s.correct;
      const pts = scoreFor(q.difficulty, a ? a.t : 20, ok);
      s.scores[p.id] = (s.scores[p.id] || 0) + pts;
      s.gains[p.id] = { choice: a ? a.choice : -1, pts, correct: ok };
    });
    s.phase = 'reveal';
    s.autoAt = this.solo ? 0 : this.now() + REVEAL_MS;
    this.pub();
  }
  next() {
    const s = this.s;
    if (s.phase === 'reveal') {
      if (s.qi >= s.order.length - 1) { s.phase = 'final'; s.autoAt = 0; return this.pub(); }
      if (this.solo) { s.qi++; return this.startQuestion(); }
      s.phase = 'board';
      s.autoAt = s.settings.auto ? this.now() + BOARD_AUTO_MS : 0;
      return this.pub();
    }
    if (s.phase === 'board') { s.qi++; return this.startQuestion(); }
  }
  reset() { // "Play again": back to the lobby with the same players
    const s = this.s;
    if (s.phase !== 'final') return;
    s.phase = 'lobby'; s.order = []; s.qi = -1; s.answers = {}; s.gains = {}; s.correct = -1; s.autoAt = 0;
    s.players.forEach((p) => { s.scores[p.id] = 0; });
    this.pub();
  }
  // Drive from a timer (every ~250 ms). Ends the question even if nobody answered.
  tick() {
    const s = this.s, now = this.now();
    if (s.phase === 'question' && now >= s.deadlineAt + GRACE_MS) this.endQuestion();
    else if ((s.phase === 'reveal' || s.phase === 'board') && s.autoAt && now >= s.autoAt) this.next();
  }
  touch() { this.s.savedAt = this.now(); this.save(this.serialize()); }
  // After a host reload: the clock was paused while the host was away.
  resume() {
    const s = this.s, now = this.now();
    const gap = Math.max(0, now - (s.savedAt || now));
    if (s.phase === 'question') { s.sentAt += gap; s.deadlineAt += gap; }
    else if (s.phase === 'reveal') s.autoAt = this.solo ? 0 : now + REVEAL_MS;
    else if (s.phase === 'board') s.autoAt = s.settings.auto ? now + BOARD_AUTO_MS : 0;
    this.pub();
  }
  serialize() { return JSON.parse(JSON.stringify(this.s)); }
  pub() {
    this.s.seq++;
    this.s.savedAt = this.now();
    this.save(this.serialize());
    this.emit(this.snapshot());
  }
  // What clients may see. The correct index and explanation exist only in 'reveal'.
  snapshot() {
    const s = this.s, online = this.getOnline(), now = this.now();
    const snap = {
      type: 'state', seq: s.seq, code: s.code, hostId: s.hostId, phase: s.phase,
      settings: { ...s.settings }, qi: s.qi,
      total: s.order.length || (this.solo ? SOLO_COUNT : s.settings.count),
      players: s.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, online: online ? online.has(p.id) : true, score: s.scores[p.id] || 0 })),
    };
    if (s.phase === 'question' || s.phase === 'reveal') {
      const q = this.byId[s.order[s.qi]];
      snap.q = { q: q.q, options: s.perm.map((k) => q.options[k]), diff: q.difficulty, cat: q.category };
      snap.answered = Object.keys(s.answers);
    }
    if (s.phase === 'question') { snap.dur = QUESTION_MS / 1000; snap.remaining = Math.max(0, (s.deadlineAt - now) / 1000); }
    if (s.phase === 'reveal') { snap.correct = s.correct; snap.explain = this.byId[s.order[s.qi]].explain; }
    if (s.phase === 'reveal' || s.phase === 'board') snap.gains = s.gains;
    return snap;
  }
}

/* ====================================================================
   i18n
   ==================================================================== */
const STR = {
  en: {
    tagline: 'Test your knowledge of Azeroth', yourName: 'Your name', namePh: 'Hero name', pickAvatar: 'Choose your avatar',
    create: 'Create game', solo: 'Solo', joinCode: 'Join with a room code', join: 'Join', defaultName: 'Hero',
    mpOff: 'Multiplayer is not set up yet. Add your Supabase URL and anon key to config.js. Solo mode works without it.',
    newGame: 'New game', hostRole: 'How do you want to host?', hostPlays: 'I play along', hostPlaysHint: 'You answer on this device',
    hostPresents: 'I present', hostPresentsHint: 'This is the big screen', numQuestions: 'Number of questions',
    autoAdvance: 'Auto-advance (6 s)', createRoom: 'Create room', back: 'Back',
    roomCode: 'Room code', copyLink: 'Copy invite link', linkCopied: 'Invite link copied!', players: 'Players',
    playersCount: '{n} / {max} players', waitingPlayers: 'Waiting for players…', start: 'Start game',
    needMin: 'At least {n} players are needed to start.', waitHostStart: 'Waiting for the host to start…',
    hostBadge: 'Host', you: 'you', offline: 'offline', leave: 'Leave', leaveConfirm: 'Leave the game?',
    connecting: 'Connecting…', joinTitle: 'Join game', roomFull: 'This room is full (max {max} players).',
    hostGone: 'Host disconnected, waiting...', connError: 'Connection problem. Trying to reconnect…',
    createFailed: 'Could not create the room. Check your connection and Supabase settings.',
    joinFailed: 'Could not connect to the room.',
    questionN: 'Question {n} / {total}', timeUp: "Time's up!", locked: 'Answer locked in', answeredCount: '{n} / {m} answered',
    correct: 'Correct!', wrong: 'Wrong', noAnswer: 'No answer', explanation: 'Did you know?',
    scoreboard: 'Scoreboard', nextQuestion: 'Next question', toBoard: 'Scoreboard', toFinal: 'Final results',
    finalTitle: 'Final results', winner: '{name} wins!', playAgain: 'Play again', waitHostAgain: 'Waiting for the host…',
    home: 'Home', soloTitle: 'Solo run', yourScore: 'Your score', best: 'Best', newRecord: 'New record!',
    soundOn: 'Sound on', soundOff: 'Sound off', autoOn: 'Auto-advance on', pts: 'pts',
    cat_lore: 'Lore', cat_characters: 'Characters', cat_expansions: 'Expansions', cat_classes: 'Classes', cat_races: 'Races', cat_zones: 'Zones', cat_dungeons: 'Dungeons & raids',
    diff_1: 'Easy', diff_2: 'Medium', diff_3: 'Hard',
    footer: 'Unofficial fan project. Not affiliated with Blizzard Entertainment. World of Warcraft and Warcraft are trademarks of Blizzard Entertainment, Inc.',
    loadFailed: 'Could not load the game data.',
  },
  fi: {
    tagline: 'Testaa Azerothin tuntemuksesi', yourName: 'Nimesi', namePh: 'Sankarin nimi', pickAvatar: 'Valitse hahmosi',
    create: 'Luo peli', solo: 'Yksin', joinCode: 'Liity huonekoodilla', join: 'Liity', defaultName: 'Sankari',
    mpOff: 'Moninpeliä ei ole vielä otettu käyttöön. Lisää Supabase URL ja anon-avain tiedostoon config.js. Yksinpeli toimii ilman niitä.',
    newGame: 'Uusi peli', hostRole: 'Miten haluat isännöidä?', hostPlays: 'Pelaan mukana', hostPlaysHint: 'Vastaat tällä laitteella',
    hostPresents: 'Esitän', hostPresentsHint: 'Tämä on iso näyttö', numQuestions: 'Kysymysten määrä',
    autoAdvance: 'Automaattinen eteneminen (6 s)', createRoom: 'Luo huone', back: 'Takaisin',
    roomCode: 'Huonekoodi', copyLink: 'Kopioi kutsulinkki', linkCopied: 'Kutsulinkki kopioitu!', players: 'Pelaajat',
    playersCount: '{n} / {max} pelaajaa', waitingPlayers: 'Odotetaan pelaajia…', start: 'Aloita peli',
    needMin: 'Aloittamiseen tarvitaan vähintään {n} pelaajaa.', waitHostStart: 'Odotetaan, että isäntä aloittaa…',
    hostBadge: 'Isäntä', you: 'sinä', offline: 'poissa', leave: 'Poistu', leaveConfirm: 'Poistutaanko pelistä?',
    connecting: 'Yhdistetään…', joinTitle: 'Liity peliin', roomFull: 'Huone on täynnä (enintään {max} pelaajaa).',
    hostGone: 'Isäntä katkaisi yhteyden, odotetaan...', connError: 'Yhteysongelma. Yritetään yhdistää uudelleen…',
    createFailed: 'Huoneen luonti epäonnistui. Tarkista yhteys ja Supabase-asetukset.',
    joinFailed: 'Huoneeseen ei saatu yhteyttä.',
    questionN: 'Kysymys {n} / {total}', timeUp: 'Aika loppui!', locked: 'Vastaus lukittu', answeredCount: '{n} / {m} vastannut',
    correct: 'Oikein!', wrong: 'Väärin', noAnswer: 'Ei vastausta', explanation: 'Tiesitkö?',
    scoreboard: 'Pistetilanne', nextQuestion: 'Seuraava kysymys', toBoard: 'Pistetilanne', toFinal: 'Lopputulokset',
    finalTitle: 'Lopputulokset', winner: '{name} voittaa!', playAgain: 'Pelaa uudelleen', waitHostAgain: 'Odotetaan isäntää…',
    home: 'Alkuun', soloTitle: 'Yksinpeli', yourScore: 'Pisteesi', best: 'Paras', newRecord: 'Uusi ennätys!',
    soundOn: 'Ääni päällä', soundOff: 'Ääni pois', autoOn: 'Automaattinen eteneminen päällä', pts: 'p',
    cat_lore: 'Tarusto', cat_characters: 'Hahmot', cat_expansions: 'Lisäosat', cat_classes: 'Hahmoluokat', cat_races: 'Rodut', cat_zones: 'Alueet', cat_dungeons: 'Dungeonit ja raidit',
    diff_1: 'Helppo', diff_2: 'Keskivaikea', diff_3: 'Vaikea',
    footer: 'Epävirallinen fanihanke. Ei sidoksissa Blizzard Entertainmentiin. World of Warcraft ja Warcraft ovat Blizzard Entertainment, Inc:n tavaramerkkejä.',
    loadFailed: 'Pelin tietojen lataus epäonnistui.',
  },
};
export const I18N = STR;

/* ====================================================================
   Browser app
   ==================================================================== */
const hasDOM = typeof document !== 'undefined';
const MP_READY = !!SUPABASE_URL && !!SUPABASE_ANON_KEY && /^https:\/\//.test(SUPABASE_URL) && !/YOUR/i.test(SUPABASE_URL + SUPABASE_ANON_KEY);

const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const SS = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
};
const HOST_KEY = 'wowtrivia.host', JOINED_KEY = 'wowtrivia.joined', PROFILE_KEY = 'wowtrivia.profile', BEST_KEY = 'wowtrivia.best';

function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const app = {
  lang: 'en', muted: false,
  profile: { id: '', name: '', avatar: AVATARS[0] },
  cfg: { hostPlays: true, count: 10, auto: false },
  mode: 'home', presenting: false,
  S: null, engine: null, ch: null, sb: null, meta: null,
  online: new Set(), hostOnline: false, rejected: new Set(),
  endsAt: 0, timeUp: false, paused: false, myChoice: null, lastSec: null, raf: 0,
  ui: {}, render: null, soloResult: null, joinCode: '', wake: null,
  tickI: 0, hbI: 0, hostGoneT: 0, pubT: 0, resumeT: 0,
};

const t = (key, vars = {}) => {
  let s = (STR[app.lang] && STR[app.lang][key]) ?? STR.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
};
const $ = (sel) => document.querySelector(sel);
const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role') el.setAttribute(k, v === true ? 'true' : v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/* ---------- audio (Web Audio, created only after the first tap) ---------- */
const audio = {
  ctx: null,
  unlock() {
    try {
      if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; this.ctx = new AC(); }
      if (this.ctx.state !== 'running') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); }
    } catch { /* audio is optional */ }
  },
  tone(freq, dur, { type = 'sine', delay = 0, vol = 0.12, slideTo = 0 } = {}) {
    if (app.muted || !this.ctx || this.ctx.state !== 'running') return;
    try {
      const c = this.ctx, t0 = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.03);
    } catch { /* ignore */ }
  },
  tick() { this.tone(1000, 0.05, { type: 'square', vol: 0.04 }); },
  correct() { this.tone(660, 0.12); this.tone(880, 0.16, { delay: 0.11 }); this.tone(1320, 0.28, { delay: 0.22, vol: 0.1 }); },
  wrong() { this.tone(220, 0.38, { type: 'sawtooth', vol: 0.07, slideTo: 110 }); },
  victory() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, { delay: i * 0.14, type: 'triangle' })); this.tone(1047, 0.7, { delay: 0.62, type: 'triangle' }); },
};

/* ---------- chrome: header, footer, toast, overlay ---------- */
function updateChrome() {
  document.documentElement.lang = app.lang;
  document.title = 'WoW Trivia';
  document.querySelectorAll('.langs button').forEach((b) => b.classList.toggle('on', b.dataset.lang === app.lang));
  const mb = $('#muteBtn');
  mb.textContent = app.muted ? '🔇' : '🔊';
  mb.setAttribute('aria-label', app.muted ? t('soundOff') : t('soundOn'));
  const lb = $('#leaveBtn');
  lb.hidden = app.mode === 'home';
  lb.setAttribute('aria-label', t('leave'));
  $('#footer').textContent = t('footer');
  $('#app').classList.toggle('big', app.mode === 'host' && app.presenting);
}
let toastT = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2800);
}
function mount(...nodes) {
  const root = $('#app');
  root.replaceChildren(...nodes);
  updateChrome();
  window.scrollTo(0, 0);
}
function setLang(l) {
  app.lang = l; LS.set('wowtrivia.lang', l);
  updateChrome();
  if (!$('#overlay').hidden) showOverlay();
  if (app.render) app.render();
}
function saveProfile() { LS.set(PROFILE_KEY, JSON.stringify(app.profile)); }

function showOverlay() {
  const o = $('#overlay');
  o.replaceChildren(h('div', { class: 'spinner' }), h('p', {}, t('hostGone')), h('button', { class: 'btn ghost', type: 'button', onclick: leaveToHome }, t('leave')));
  o.hidden = false; app.paused = true;
}
function hideOverlay() {
  const o = $('#overlay');
  if (o.hidden) return;
  o.hidden = true;
  clearTimeout(app.resumeT);
  app.resumeT = setTimeout(() => { app.paused = false; }, 1500); // a fresh state normally unpauses sooner
}

/* ---------- wake lock (keeps screens on during a game) ---------- */
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !app.wake) {
      app.wake = await navigator.wakeLock.request('screen');
      app.wake.addEventListener('release', () => { app.wake = null; });
    }
  } catch { /* not allowed / unsupported */ }
}
function releaseWake() { try { if (app.wake) app.wake.release(); } catch { /* ignore */ } app.wake = null; }

/* ---------- Supabase ---------- */
let sbPromise = null;
function getSupabase() {
  if (!sbPromise) {
    sbPromise = import(SUPABASE_CDN)
      .then((m) => m.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 20 } },
      }))
      .catch((e) => { sbPromise = null; throw e; });
  }
  return sbPromise;
}
async function openChannel(code, meta, on) {
  const sb = await getSupabase();
  app.sb = sb; app.meta = meta;
  const ch = sb.channel(`room-${code}`, { config: { broadcast: { self: false }, presence: { key: meta.id } } });
  ch.on('presence', { event: 'sync' }, () => on.presence && on.presence(ch.presenceState()));
  for (const [ev, fn] of Object.entries(on.broadcast || {})) ch.on('broadcast', { event: ev }, ({ payload }) => fn(payload));
  await new Promise((resolve, reject) => {
    let done = false;
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        try { await ch.track(meta); } catch { /* retried on next subscribe */ }
        if (!done) { done = true; resolve(); } else if (on.resubscribed) on.resubscribed();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (!done) { done = true; reject(new Error(status)); } else toast(t('connError'));
      }
    });
  });
  app.ch = ch;
  return ch;
}
function send(event, payload) {
  if (!app.ch) return Promise.resolve('error');
  return Promise.resolve(app.ch.send({ type: 'broadcast', event, payload })).catch(() => 'error');
}

/* ---------- navigation ---------- */
function stopLoops() {
  cancelAnimationFrame(app.raf);
  clearInterval(app.tickI); clearInterval(app.hbI);
  clearTimeout(app.hostGoneT); clearTimeout(app.pubT);
}
async function leaveToHome(message) {
  stopLoops(); releaseWake();
  $('#overlay').hidden = true; app.paused = false;
  try { if (app.ch && app.sb) await app.sb.removeChannel(app.ch); } catch { /* ignore */ }
  if (app.mode === 'host') LS.del(HOST_KEY);
  LS.del(JOINED_KEY);
  Object.assign(app, { engine: null, S: null, ch: null, mode: 'home', presenting: false, online: new Set(), hostOnline: false, rejected: new Set(), myChoice: null, soloResult: null });
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  screenHome();
  if (typeof message === 'string' && message) toast(message);
}

/* ====================================================================
   Screens
   ==================================================================== */
function avatarPicker() {
  const wrap = h('div', { class: 'avatars', role: 'group', 'aria-label': t('pickAvatar') });
  AVATARS.forEach((a) => {
    wrap.append(h('button', {
      type: 'button', class: 'avatar-btn', 'aria-pressed': String(app.profile.avatar === a),
      onclick: () => { app.profile.avatar = a; saveProfile(); wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === a))); },
    }, a));
  });
  return wrap;
}
function nameField() {
  return h('div', {}, h('label', { class: 'field', htmlFor: 'nameIn' }, t('yourName')),
    h('input', {
      id: 'nameIn', type: 'text', maxLength: 16, value: app.profile.name, placeholder: t('namePh'), autocomplete: 'off',
      oninput: (e) => { app.profile.name = e.target.value; saveProfile(); },
    }));
}
function profileName() {
  const n = cleanName(app.profile.name || t('defaultName'));
  return n;
}
function profileCard() {
  return h('div', { class: 'card' }, nameField(), h('div', { style: { height: '12px' } }), h('label', { class: 'field' }, t('pickAvatar')), avatarPicker());
}

function screenHome() {
  app.render = screenHome; app.mode = 'home'; app.S = null;
  const codeIn = h('input', { type: 'text', class: 'codeinput', maxLength: 5, placeholder: 'ABCDE', 'aria-label': t('joinCode'), autocapitalize: 'characters', autocomplete: 'off' });
  mount(h('section', { class: 'screen' },
    h('div', { class: 'hero' }, h('h1', {}, 'WoW Trivia'), h('p', { class: 'muted' }, t('tagline'))),
    !MP_READY && h('div', { class: 'banner', role: 'alert' }, t('mpOff')),
    profileCard(),
    h('button', { class: 'btn primary', type: 'button', disabled: !MP_READY, onclick: screenCreate }, t('create')),
    h('button', { class: 'btn', type: 'button', onclick: startSolo }, t('solo')),
    MP_READY && h('div', { class: 'card' },
      h('label', { class: 'field' }, t('joinCode')),
      h('div', { class: 'btnrow' }, codeIn, h('button', {
        class: 'btn violet', type: 'button', style: { flex: '0 0 40%' },
        onclick: () => { const c = codeIn.value.trim().toUpperCase(); if (/^[A-Z0-9]{5}$/.test(c)) { app.joinCode = c; joinRoom(c); } else codeIn.focus(); },
      }, t('join'))))));
}

function countSeg(value, onPick) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': t('numQuestions') },
    [10, 15, 20].map((n) => h('button', { type: 'button', 'aria-pressed': String(value === n), onclick: () => onPick(n) }, String(n))));
}
function autoSwitch(checked, onChange) {
  return h('label', { class: 'switch' }, h('span', {}, t('autoAdvance')),
    h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }));
}

function screenCreate() {
  app.render = screenCreate;
  const c = app.cfg;
  const roleBtn = (plays, title, hint) => h('button', { type: 'button', 'aria-pressed': String(c.hostPlays === plays), onclick: () => { c.hostPlays = plays; screenCreate(); } }, title, h('small', {}, hint));
  mount(h('section', { class: 'screen' },
    h('h2', {}, t('newGame')),
    h('div', { class: 'card' }, h('label', { class: 'field' }, t('hostRole')),
      h('div', { class: 'seg' }, roleBtn(true, t('hostPlays'), t('hostPlaysHint')), roleBtn(false, t('hostPresents'), t('hostPresentsHint')))),
    h('div', { class: 'card' }, h('label', { class: 'field' }, t('numQuestions')), countSeg(c.count, (n) => { c.count = n; screenCreate(); })),
    h('div', { class: 'card' }, autoSwitch(c.auto, (v) => { c.auto = v; })),
    h('button', { class: 'btn primary', type: 'button', onclick: createRoom }, t('createRoom')),
    h('button', { class: 'btn ghost', type: 'button', onclick: screenHome }, t('back'))));
}

function screenConnecting() {
  app.render = screenConnecting;
  mount(h('section', { class: 'screen center' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, t('connecting'))));
}

function screenJoin(code) {
  app.render = () => screenJoin(code); app.joinCode = code;
  mount(h('section', { class: 'screen' },
    h('h2', {}, t('joinTitle')),
    h('div', { class: 'card codebox' }, h('div', { class: 'muted small' }, t('roomCode')), h('div', { class: 'code', style: { fontSize: '2rem' } }, code)),
    profileCard(),
    MP_READY ? h('button', { class: 'btn primary', type: 'button', onclick: () => joinRoom(code) }, t('join')) : h('div', { class: 'banner', role: 'alert' }, t('mpOff')),
    h('button', { class: 'btn ghost', type: 'button', onclick: screenHome }, t('back'))));
}

function inviteLink(code) { return `${location.origin}${location.pathname}?room=${code}`; }
async function copyLink(link) {
  let ok = false;
  try { await navigator.clipboard.writeText(link); ok = true; } catch { /* fall back below */ }
  if (!ok) {
    const ta = h('textarea', { value: link, readOnly: true, style: { position: 'fixed', top: '0', opacity: '0' } });
    document.body.append(ta); ta.focus(); ta.select();
    try { ta.setSelectionRange(0, link.length); ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? t('linkCopied') : link);
}
function playerRow(p, S) {
  const isHost = p.id === S.hostId;
  return h('div', { class: 'prow' + (p.online ? '' : ' off') },
    h('span', { class: 'av' }, p.avatar), h('span', { class: 'nm' }, p.name),
    p.id === app.profile.id && h('span', { class: 'tag' }, t('you')),
    isHost && h('span', { class: 'tag gold' }, t('hostBadge')),
    !p.online && h('span', { class: 'tag' }, t('offline')));
}

function screenLobby() {
  const S = app.S, isHost = app.mode === 'host', e = app.engine;
  const n = S.players.length;
  const canStart = isHost && e.canStart();
  mount(h('section', { class: 'screen' },
    h('div', { class: 'card codebox' },
      h('div', { class: 'muted small' }, t('roomCode')), h('div', { class: 'code' }, S.code),
      isHost && h('div', { class: 'linktxt' }, inviteLink(S.code))),
    isHost && h('button', { class: 'btn violet', type: 'button', onclick: () => copyLink(inviteLink(S.code)) }, '🔗 ' + t('copyLink')),
    h('div', { class: 'card' },
      h('div', { class: 'btnrow', style: { justifyContent: 'space-between', marginBottom: '10px' } }, h('strong', {}, t('players')), h('span', { class: 'muted small' }, t('playersCount', { n, max: MAX_PLAYERS }))),
      n ? h('div', { class: 'plist' }, S.players.map((p) => playerRow(p, S))) : h('p', { class: 'muted' }, t('waitingPlayers'))),
    isHost && h('div', { class: 'card' },
      h('label', { class: 'field' }, t('numQuestions')), countSeg(S.settings.count, (c) => e.setSettings({ count: c })),
      autoSwitch(S.settings.auto, (v) => e.setSettings({ auto: v }))),
    isHost
      ? [h('button', { class: 'btn primary', type: 'button', disabled: !canStart, onclick: () => e.start() }, t('start')),
        !canStart && h('p', { class: 'muted center small' }, t('needMin', { n: MIN_PLAYERS }))]
      : h('p', { class: 'muted center' }, t('waitHostStart'))));
}

/* ---- question ---- */
const RING_C = 163.36;
function iPlay() { return app.mode === 'solo' || app.mode === 'player' || (app.mode === 'host' && !app.presenting); }
function meRow() { return app.S.players.find((p) => p.id === app.profile.id); }

function screenQuestion() {
  const S = app.S, lang = app.lang, q = S.q;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 60 60');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  [['class', 'bg'], ['cx', 30], ['cy', 30], ['r', 26]].forEach(([k, v]) => bg.setAttribute(k, v));
  const fgs = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  [['class', 'fg'], ['cx', 30], ['cy', 30], ['r', 26], ['transform', 'rotate(-90 30 30)']].forEach(([k, v]) => fgs.setAttribute(k, v));
  svg.append(bg, fgs);
  const num = h('span', { class: 'num' }, String(S.dur));
  const ring = h('div', { class: 'ring', role: 'timer' }, svg, num);
  const answers = h('div', { class: 'answers', role: 'group' },
    q.options.map((o, i) => h('button', { type: 'button', class: 'answer', 'data-i': String(i), onclick: () => choose(i) },
      h('span', { class: 'letter' }, 'ABCD'[i]), h('span', { class: 'atext' }, o[lang]))));
  const chips = h('div', { class: 'chips' });
  const count = h('span', { class: 'muted small' });
  const status = h('div', { class: 'timeup', 'aria-live': 'polite' });
  const me = iPlay() ? meRow() : null;
  app.ui = { fg: fgs, num, ring, answers, chips, count, status };
  mount(h('section', { class: 'screen question' },
    h('div', { class: 'qtop' }, h('span', { class: 'qn' }, t('questionN', { n: S.qi + 1, total: S.total })), ring, h('span', { class: 'sc' }, me ? `${me.score}` : '')),
    h('div', { class: 'meta' }, h('span', { class: 'tag' }, t('cat_' + q.cat)), h('span', { class: 'tag gold' }, '★'.repeat(q.diff) + ' ' + t('diff_' + q.diff))),
    h('h2', { class: 'qtext' }, q.q[lang]),
    h('div', {}, chips, count),
    status, answers));
  renderChips(); applyLock(); startTimerLoop();
}
function renderChips() {
  const S = app.S, ui = app.ui; if (!ui.chips) return;
  ui.chips.replaceChildren(...S.players.map((p) => h('span', { class: 'chip' + (S.answered.includes(p.id) ? ' done' : ''), title: p.name }, p.avatar)));
  ui.count.textContent = t('answeredCount', { n: S.answered.length, m: S.players.length });
}
function applyLock() {
  const ui = app.ui; if (!ui.answers || !app.S || app.S.phase !== 'question') return;
  const S = app.S;
  const answered = app.myChoice !== null || S.answered.includes(app.profile.id);
  const locked = answered || app.timeUp || !iPlay();
  ui.answers.classList.toggle('locked', locked);
  [...ui.answers.children].forEach((b, i) => { b.classList.toggle('selected', app.myChoice === i); b.setAttribute('aria-disabled', String(locked)); });
  ui.status.textContent = answered && iPlay() ? t('locked') : (app.timeUp && iPlay() ? t('timeUp') : '');
  ui.status.style.color = answered ? 'var(--muted)' : '';
}
function choose(i) {
  const S = app.S;
  if (!S || S.phase !== 'question' || !iPlay()) return;
  if (app.myChoice !== null || app.timeUp || S.answered.includes(app.profile.id)) return;
  app.myChoice = i;
  SS.set(`wt.ans.${S.code}.${S.qi}`, String(i));
  applyLock();
  sendAnswer(S.qi, i, 0);
}
function sendAnswer(qi, choice, attempt) {
  if (app.mode === 'host' || app.mode === 'solo') { app.engine.answer(app.profile.id, qi, choice); return; }
  send('answer', { pid: app.profile.id, qi, choice });
  // If the host never confirmed us in "answered", resend; the host counts each player only once.
  setTimeout(() => {
    const S = app.S;
    if (S && S.phase === 'question' && S.qi === qi && !S.answered.includes(app.profile.id) && attempt < 3) sendAnswer(qi, choice, attempt + 1);
  }, 1500);
}
function startTimerLoop() {
  cancelAnimationFrame(app.raf); app.lastSec = null;
  const loop = () => {
    const S = app.S, ui = app.ui;
    if (!S || S.phase !== 'question' || !ui.fg || !ui.fg.isConnected) return;
    if (!app.paused) {
      const rem = Math.max(0, (app.endsAt - performance.now()) / 1000);
      ui.fg.style.strokeDashoffset = String(RING_C * (1 - rem / S.dur));
      const sec = Math.ceil(rem);
      ui.num.textContent = String(sec);
      ui.ring.classList.toggle('urgent', rem > 0 && rem <= 5);
      if (sec !== app.lastSec) { app.lastSec = sec; if (sec > 0 && sec <= 5) audio.tick(); }
      if (rem <= 0 && !app.timeUp) { app.timeUp = true; applyLock(); }
    }
    app.raf = requestAnimationFrame(loop);
  };
  app.raf = requestAnimationFrame(loop);
}

/* ---- reveal ---- */
function hostControls(label, onClick) {
  return app.mode === 'host' ? h('button', { class: 'btn primary', type: 'button', onclick: onClick }, label) : null;
}
function screenReveal() {
  const S = app.S, lang = app.lang, q = S.q, g = S.gains || {};
  const mine = iPlay() ? g[app.profile.id] : null;
  const last = S.qi >= S.total - 1;
  const answers = h('div', { class: 'answers locked reveal' }, q.options.map((o, i) => {
    const picks = S.players.filter((p) => g[p.id] && g[p.id].choice === i);
    const cls = 'answer ' + (i === S.correct ? 'correct' : 'wrong') + (mine && mine.choice === i && i !== S.correct ? ' mine' : '');
    return h('div', { class: cls }, h('span', { class: 'letter' }, 'ABCD'[i]), h('span', { class: 'atext' }, o[lang]),
      h('span', { class: 'picks' }, picks.map((p) => h('span', { title: p.name }, p.avatar))));
  }));
  let banner = null;
  if (iPlay()) {
    if (mine && mine.correct) banner = h('div', { class: 'result ok' }, `${t('correct')} +${mine.pts}`);
    else if (mine && mine.choice >= 0) banner = h('div', { class: 'result bad' }, t('wrong'));
    else banner = h('div', { class: 'result none' }, t('noAnswer'));
  }
  const sorted = S.players.slice().sort((a, b) => ((g[b.id] && g[b.id].pts) || 0) - ((g[a.id] && g[a.id].pts) || 0));
  const act = app.mode === 'solo'
    ? h('button', { class: 'btn primary', type: 'button', onclick: () => app.engine.next() }, last ? t('toFinal') : t('nextQuestion'))
    : hostControls(last ? t('toFinal') : t('toBoard'), () => app.engine.next());
  mount(h('section', { class: 'screen' },
    h('div', { class: 'qtop' }, h('span', { class: 'qn' }, t('questionN', { n: S.qi + 1, total: S.total }))),
    h('h2', { class: 'qtext' }, q.q[lang]),
    banner, answers,
    h('div', { class: 'card explain' }, h('h3', {}, t('explanation')), h('div', {}, S.explain[lang])),
    app.mode !== 'solo' && h('div', { class: 'plist' }, sorted.map((p) => {
      const pts = (g[p.id] && g[p.id].pts) || 0;
      return h('div', { class: 'gainrow' }, h('span', {}, p.avatar), h('span', { class: 'nm' }, p.name),
        h('span', { class: 'pts' + (pts ? '' : ' zero') }, pts ? `+${pts}` : '0'), h('span', {}, g[p.id] && g[p.id].correct ? '✅' : '❌'));
    })),
    act));
}

/* ---- scoreboard ---- */
function screenBoard() {
  const S = app.S, g = S.gains || {}, ROW = 64, n = S.players.length;
  const now = rankMap(S.players, (p) => p.score);
  const prev = rankMap(S.players, (p) => p.score - ((g[p.id] && g[p.id].pts) || 0));
  const animate = !reduceMotion();
  const rows = S.players.map((p) => {
    const gain = (g[p.id] && g[p.id].pts) || 0;
    const diff = prev[p.id] - now[p.id];
    const scoreEl = h('span', { class: 'sc' }, String(animate ? p.score - gain : p.score));
    const row = h('div', { class: 'brow' + (p.id === app.profile.id ? ' me' : ''), style: { transform: `translateY(${(animate ? prev[p.id] : now[p.id]) * ROW}px)` } },
      h('span', { class: 'rk' }, String(now[p.id] + 1)), h('span', { class: 'av' }, p.avatar), h('span', { class: 'nm' }, p.name),
      gain ? h('span', { class: 'gain' }, `+${gain}`) : null,
      h('span', { class: 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '') }, diff > 0 ? `▲${diff}` : diff < 0 ? `▼${-diff}` : ''),
      scoreEl);
    return { row, scoreEl, p, gain };
  });
  const board = h('div', { class: 'board', style: { height: `${n * ROW}px` } }, rows.map((r) => r.row));
  mount(h('section', { class: 'screen' },
    h('h2', { class: 'center' }, t('scoreboard')), board,
    S.settings.auto && h('div', { class: 'autobar', title: t('autoOn') }, h('i')),
    app.mode === 'host' && h('div', { class: 'card' }, autoSwitch(S.settings.auto, (v) => app.engine.setSettings({ auto: v }))),
    hostControls(t('nextQuestion'), () => app.engine.next())));
  if (animate) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      rows.forEach((r) => { r.row.style.transform = `translateY(${now[r.p.id] * ROW}px)`; });
      const t0 = performance.now(), dur = 600;
      const step = (ts) => {
        const k = Math.min(1, (ts - t0) / dur);
        rows.forEach((r) => { if (r.scoreEl.isConnected) r.scoreEl.textContent = String(Math.round(r.p.score - r.gain + r.gain * k)); });
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }));
  }
}

/* ---- final ---- */
function confetti() {
  if (reduceMotion()) return;
  const wrap = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  const colors = ['#E2B04A', '#9C7BF0', '#5AA9F0', '#4CC38A', '#E5484D'];
  for (let i = 0; i < 44; i++) {
    wrap.append(h('i', { style: { left: `${Math.random() * 100}%`, background: colors[i % colors.length], animationDuration: `${2.5 + Math.random() * 2.5}s`, animationDelay: `${Math.random() * 0.8}s`, transform: `rotate(${Math.random() * 360}deg)` } }));
  }
  document.body.append(wrap);
  setTimeout(() => wrap.remove(), 6500);
}
function screenFinal() {
  const S = app.S;
  if (app.mode === 'solo') return screenSoloFinal();
  const ranks = rankMap(S.players, (p) => p.score);
  const sorted = S.players.slice().sort((a, b) => ranks[a.id] - ranks[b.id]);
  const top = sorted.slice(0, 3);
  const winner = sorted[0];
  mount(h('section', { class: 'screen' },
    h('h2', { class: 'center' }, t('finalTitle')),
    winner && h('div', { class: 'winner' }, '🏆 ' + t('winner', { name: winner.name })),
    h('div', { class: 'podium' }, top.map((p, i) => h('div', { class: `pcol p${i + 1}` },
      i === 0 && h('span', { class: 'crown' }, '👑'), h('span', { class: 'av' }, p.avatar), h('span', { class: 'nm' }, p.name),
      h('span', { class: 'sc' }, `${p.score}`), h('div', { class: 'pblock' }, String(i + 1))))),
    sorted.length > 3 && h('div', { class: 'plist' }, sorted.slice(3).map((p, i) => h('div', { class: 'gainrow' }, h('span', { class: 'rk' }, String(i + 4)), h('span', {}, p.avatar), h('span', { class: 'nm' }, p.name), h('span', { class: 'pts' }, `${p.score}`)))),
    app.mode === 'host' ? h('button', { class: 'btn primary', type: 'button', onclick: () => app.engine.reset() }, t('playAgain'))
      : h('p', { class: 'muted center' }, t('waitHostAgain')),
    h('button', { class: 'btn ghost', type: 'button', onclick: leaveToHome }, t('home'))));
}
function screenSoloFinal() {
  const r = app.soloResult || { score: 0, best: 0, record: false };
  mount(h('section', { class: 'screen center' },
    h('h2', {}, t('soloTitle')), h('div', { class: 'muted' }, t('yourScore')), h('div', { class: 'bigscore' }, String(r.score)),
    r.record && h('div', { class: 'record' }, '🏆 ' + t('newRecord')),
    h('div', { class: 'muted' }, `${t('best')}: ${r.best}`),
    h('button', { class: 'btn primary', type: 'button', onclick: startSolo }, t('playAgain')),
    h('button', { class: 'btn ghost', type: 'button', onclick: leaveToHome }, t('home'))));
}

/* ====================================================================
   State from the engine / host -> UI (same path for Solo, host and players)
   ==================================================================== */
function showPhase() {
  const S = app.S; if (!S) return;
  ({ lobby: screenLobby, question: screenQuestion, reveal: screenReveal, board: screenBoard, final: screenFinal })[S.phase]();
}
function receive(snap) {
  if (!snap || snap.type !== 'state') return;
  const prev = app.S;
  if (prev && prev.code === snap.code && snap.seq < prev.seq) return; // stale / out of order
  app.S = snap;
  if (app.mode === 'player') app.hostOnline = true; // a state broadcast proves the host is alive
  clearTimeout(app.hostGoneT); hideOverlay(); app.paused = false;
  if (snap.phase === 'question') app.endsAt = performance.now() + snap.remaining * 1000;
  app.render = showPhase;
  const changed = !prev || prev.code !== snap.code || prev.phase !== snap.phase || prev.qi !== snap.qi;
  if (changed) {
    if (snap.phase === 'question') {
      app.timeUp = false;
      const saved = SS.get(`wt.ans.${snap.code}.${snap.qi}`);
      app.myChoice = saved !== null && snap.q.options[Number(saved)] ? Number(saved) : null;
    }
    if (snap.phase === 'reveal' && iPlay()) {
      const g = snap.gains && snap.gains[app.profile.id];
      if (g && g.correct) audio.correct(); else audio.wrong();
    }
    if (snap.phase === 'final') {
      if (app.mode === 'solo') {
        const sc = (snap.players[0] && snap.players[0].score) || 0;
        const best = Number(LS.get(BEST_KEY, '0')) || 0;
        const record = sc > best;
        if (record) LS.set(BEST_KEY, String(sc));
        app.soloResult = { score: sc, best: Math.max(best, sc), record };
      }
      audio.victory(); confetti();
    }
    showPhase();
  } else if (snap.phase === 'question') {
    if (snap.remaining > 0.3 && app.timeUp) app.timeUp = false;
    renderChips(); applyLock();
  } else if (snap.phase === 'lobby') {
    showPhase();
  }
}

/* ====================================================================
   Solo
   ==================================================================== */
async function loadPool() { return (await import('./questions.js')).QUESTIONS; }
function startLoops(isHost) {
  clearInterval(app.tickI); clearInterval(app.hbI);
  app.tickI = setInterval(() => app.engine && app.engine.tick(), 250);
  if (isHost) app.hbI = setInterval(() => app.engine && app.engine.touch(), 2000);
}
async function startSolo() {
  let pool;
  try { pool = await loadPool(); } catch { toast(t('loadFailed')); return; }
  stopLoops();
  const me = app.profile;
  Object.assign(app, { mode: 'solo', presenting: false, S: null, myChoice: null, soloResult: null });
  app.engine = new Engine({ pool, solo: true, emit: receive, state: newState({ code: 'SOLO', hostId: me.id, settings: { count: SOLO_COUNT, hostPlays: true } }) });
  app.engine.addPlayer(me.id, profileName(), me.avatar);
  startLoops(false); keepAwake();
  app.engine.start();
}

/* ====================================================================
   Multiplayer: host
   ==================================================================== */
function hostEmit(msg) {
  if (app.ch) send('state', msg);
  receive(msg); // broadcast has self:false, so the host feeds itself
}
function schedulePub() {
  clearTimeout(app.pubT);
  app.pubT = setTimeout(() => app.engine && app.engine.pub(), 120);
}
function hostAddPlayer(id, name, avatar) {
  const r = app.engine.addPlayer(id, cleanName(name), AVATARS.includes(avatar) ? avatar : AVATARS[0]);
  if (r === 'full' && !app.rejected.has(id)) { app.rejected.add(id); send('reject', { pid: id, reason: 'full' }); }
  return r;
}
function hostPresence(st) {
  const e = app.engine; if (!e) return;
  const online = new Set([app.profile.id]);
  for (const [key, metas] of Object.entries(st)) {
    online.add(key);
    const m = metas[metas.length - 1];
    if (m && m.role === 'player') hostAddPlayer(key, m.name, m.avatar);
  }
  app.online = online;
  e.dropOffline(online);
  schedulePub();
}
const hostHandlers = () => ({
  presence: hostPresence,
  broadcast: {
    hello: (p) => { if (app.engine && p && p.id) { hostAddPlayer(p.id, p.name, p.avatar); schedulePub(); } },
    answer: (p) => { if (app.engine && p) app.engine.answer(String(p.pid), p.qi, p.choice); },
  },
  resubscribed: () => schedulePub(),
});
function saveHost(state) { LS.set(HOST_KEY, JSON.stringify({ code: state.code, me: app.profile.id, presenting: app.presenting, state, ts: Date.now() })); }

async function createRoom() {
  const me = app.profile, c = app.cfg;
  screenConnecting();
  try {
    const pool = await loadPool();
    app.mode = 'host'; app.presenting = !c.hostPlays;
    let code = '', ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      code = makeCode();
      const meta = { id: me.id, name: profileName(), avatar: me.avatar, role: 'host', plays: c.hostPlays };
      await openChannel(code, meta, { presence: (st) => hostPresenceEarly(st), broadcast: hostHandlers().broadcast, resubscribed: () => schedulePub() });
      await new Promise((r) => setTimeout(r, 700)); // let presence settle, then look for another host on this code
      const st = app.ch.presenceState();
      const clash = Object.entries(st).some(([k, ms]) => k !== me.id && ms.some((m) => m.role === 'host'));
      if (clash) { await app.sb.removeChannel(app.ch); app.ch = null; } else ok = true;
    }
    if (!ok) throw new Error('code');
    app.engine = new Engine({
      pool, emit: hostEmit, getOnline: () => app.online, save: saveHost,
      state: newState({ code, hostId: me.id, settings: { count: c.count, auto: c.auto, hostPlays: c.hostPlays } }),
    });
    if (c.hostPlays) app.engine.addPlayer(me.id, profileName(), me.avatar);
    app.online = new Set([me.id]);
    history.replaceState(null, '', `?room=${code}`);
    startLoops(true); keepAwake();
    app.engine.pub();
  } catch (err) {
    console.warn('createRoom failed', err);
    await leaveToHome(t('createFailed'));
  }
}
function hostPresenceEarly(st) { if (app.engine) hostPresence(st); }

async function resumeHost(saved) {
  screenConnecting();
  try {
    const pool = await loadPool();
    const st = saved.state;
    app.mode = 'host'; app.presenting = !st.settings.hostPlays;
    app.profile.id = saved.me;
    const meta = { id: app.profile.id, name: profileName(), avatar: app.profile.avatar, role: 'host', plays: st.settings.hostPlays };
    app.online = new Set([app.profile.id]);
    app.engine = new Engine({ pool, state: st, emit: hostEmit, getOnline: () => app.online, save: saveHost });
    await openChannel(st.code, meta, hostHandlers());
    startLoops(true); keepAwake();
    app.engine.resume();
  } catch (err) {
    console.warn('resumeHost failed', err);
    await leaveToHome(t('createFailed'));
  }
}

/* ====================================================================
   Multiplayer: player
   ==================================================================== */
async function joinRoom(code) {
  const me = app.profile;
  if (!MP_READY) { screenHome(); return; }
  me.name = profileName(); saveProfile();
  LS.set(JOINED_KEY, code);
  app.mode = 'player'; app.presenting = false; app.S = null;
  try { history.replaceState(null, '', `?room=${code}`); } catch { /* ignore */ }
  screenConnecting();
  const hello = () => send('hello', { id: me.id, name: me.name, avatar: me.avatar });
  const meta = { id: me.id, name: me.name, avatar: me.avatar, role: 'player' };
  app.meta = meta;
  try {
    await openChannel(code, meta, {
      presence: (st) => {
        app.online = new Set(Object.keys(st));
        app.hostOnline = Object.values(st).some((ms) => ms.some((m) => m.role === 'host'));
        clearTimeout(app.hostGoneT);
        if (app.hostOnline) { hideOverlay(); return; }
        app.hostGoneT = setTimeout(() => { if (!app.hostOnline) showOverlay(); }, app.S ? 2500 : 6000);
      },
      broadcast: {
        state: (p) => { if (p && p.code === code) receive(p); },
        reject: (p) => { if (p && p.pid === me.id) leaveToHome(t('roomFull', { max: MAX_PLAYERS })); },
      },
      resubscribed: hello,
    });
    hello();
    keepAwake();
  } catch (err) {
    console.warn('joinRoom failed', err);
    await leaveToHome(t('joinFailed'));
  }
}
function rejoinPresence() {
  if (!app.ch || !app.meta) return;
  try { Promise.resolve(app.ch.track(app.meta)).catch(() => {}); } catch { /* ignore */ }
  if (app.mode === 'player') send('hello', { id: app.profile.id, name: app.profile.name, avatar: app.profile.avatar });
}

/* ====================================================================
   Boot
   ==================================================================== */
function boot() {
  app.lang = LS.get('wowtrivia.lang') || ((navigator.language || 'en').toLowerCase().startsWith('fi') ? 'fi' : 'en');
  app.muted = LS.get('wowtrivia.muted') === '1';
  try { Object.assign(app.profile, JSON.parse(LS.get(PROFILE_KEY, '{}')) || {}); } catch { /* ignore */ }
  if (!app.profile.id) { app.profile.id = uuid(); }
  if (!AVATARS.includes(app.profile.avatar)) app.profile.avatar = AVATARS[0];
  saveProfile();

  document.querySelectorAll('.langs button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  $('#muteBtn').addEventListener('click', () => { app.muted = !app.muted; LS.set('wowtrivia.muted', app.muted ? '1' : '0'); updateChrome(); });
  $('#leaveBtn').addEventListener('click', () => {
    const inGame = app.S && ['question', 'reveal', 'board'].includes(app.S.phase);
    if (!inGame || window.confirm(t('leaveConfirm'))) leaveToHome();
  });
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((ev) => document.addEventListener(ev, () => audio.unlock(), { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.mode !== 'home') { keepAwake(); rejoinPresence(); }
  });
  window.addEventListener('online', rejoinPresence);

  const room = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (/^[A-Z0-9]{5}$/.test(room)) {
    let saved = null;
    try { saved = JSON.parse(LS.get(HOST_KEY, 'null')); } catch { saved = null; }
    if (MP_READY && saved && saved.code === room && saved.me === app.profile.id && Date.now() - saved.ts < 6 * 3600 * 1000) return resumeHost(saved);
    if (MP_READY && app.profile.name && LS.get(JOINED_KEY) === room) return joinRoom(room);
    return screenJoin(room);
  }
  screenHome();
}

if (hasDOM) boot();
