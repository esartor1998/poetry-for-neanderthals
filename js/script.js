const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------
const MIN_ROUND_S = 5;
const MAX_ROUND_S = 600;
const ROUND_STEP_S = 15;          // what the - and + buttons next to the timer move it by
const URGENT_S = 10;              // last stretch of a round, when the timer starts shouting
const COUNTDOWN_STEP_MS = 650;    // per "3", "2", "1", "Go!"
const TAP_COOLDOWN_MS = 250;      // swallows an accidental double tap that would burn a card
const BONK_VIBRATE_MS = 90;       // android only, iOS ignores navigator.vibrate
const TIME_UP_VIBRATE = [70, 50, 70, 50, 160];
const TOAST_MS = 4500;
const OPTIONS_KEY = 'vfcm.options';

const state = {
  deck: [],           // shuffled cards across every selected pack
  cardIndex: 0,       // next card to deal. carries over between rounds so nobody sees a repeat
  roundSeconds: 60,
  score: 0,
  running: false,
};

let _roundEndsAt = 0;       // performance.now() deadline for the current round
let _frame = 0;
let _shownSeconds = -1;
let _lastTapAt = 0;
let _countdownToken = 0;    // bumped to cancel a countdown that's still ticking
let _wakeLock = null;
let _toastTimer = 0;
let _focusBeforeOverlay = null;
const _packCache = new Map();

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// card data
// ---------------------------------------------------------------------------
async function loadPack(path) {
  if (_packCache.has(path)) return _packCache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.game_data)) throw new Error(`${path} has no game_data list`);
  _packCache.set(path, data.game_data);
  return data.game_data;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// once every card's been seen, reshuffle and go round again rather than
// replaying the deck in the same order
function drawCard() {
  if (state.cardIndex >= state.deck.length) {
    shuffle(state.deck);
    state.cardIndex = 0;
  }
  return state.deck[state.cardIndex++];
}

// ---------------------------------------------------------------------------
// options menu
// ---------------------------------------------------------------------------
const packInputs = () => [...el('packsField').querySelectorAll('input[type="checkbox"]')];

function readRoundSeconds() {
  const value = Number(el('timeInput').value);
  if (!Number.isInteger(value) || value < MIN_ROUND_S || value > MAX_ROUND_S) return null;
  return value;
}

function nudgeRoundSeconds(delta) {
  const current = readRoundSeconds() ?? state.roundSeconds;
  const next = Math.min(MAX_ROUND_S, Math.max(MIN_ROUND_S, current + delta));
  el('timeInput').value = String(next);
}

// the last-used options are remembered per browser. storage can be missing or
// throw (private windows, blocked site data), which only costs the memory
function saveOptions(seconds, paths) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({ seconds, paths }));
  } catch { /* not remembered, still works */ }
}

function restoreOptions() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OPTIONS_KEY)); } catch { /* defaults it is */ }
  if (!saved) return;
  if (Number.isInteger(saved.seconds)) el('timeInput').value = String(saved.seconds);
  if (Array.isArray(saved.paths) && saved.paths.length) {
    for (const input of packInputs()) input.checked = saved.paths.includes(input.value);
  }
}

function flagInvalid(element) {
  element.classList.remove('is-invalid');
  void element.offsetWidth; // restart the shake if it's already mid-animation
  element.classList.add('is-invalid');
  setTimeout(() => element.classList.remove('is-invalid'), 1200);
}

async function startGame() {
  const seconds = readRoundSeconds();
  const paths = packInputs().filter((input) => input.checked).map((input) => input.value);

  if (seconds === null) flagInvalid(el('timeField'));
  if (!paths.length) flagInvalid(el('packsField'));
  if (seconds === null || !paths.length) {
    toast(seconds === null
      ? `Pick a round length from ${MIN_ROUND_S} to ${MAX_ROUND_S} seconds.`
      : 'Pick at least one card pack.');
    return;
  }

  const startBtn = el('startBtn');
  startBtn.disabled = true;
  let cards;
  try {
    cards = (await Promise.all(paths.map(loadPack))).flat();
  } catch (err) {
    console.error('Card data failed to load:', err);
    toast('Couldn\'t load the cards. Try again in a moment.');
    return;
  } finally {
    startBtn.disabled = false;
  }

  el('toast').classList.remove('is-showing');
  state.roundSeconds = seconds;
  state.deck = shuffle([...cards]);
  state.cardIndex = 0;
  saveOptions(seconds, paths);

  showScreen('gameScreen');
  startRound();
}

// ---------------------------------------------------------------------------
// screens and overlays
// ---------------------------------------------------------------------------
function showScreen(id) {
  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('is-active', screen.id === id);
  }
  window.scrollTo(0, 0); // Start sits at the bottom of a scrolled menu on small phones
}

function openOverlay(id, focusId) {
  _focusBeforeOverlay = document.activeElement;
  el(id).classList.add('is-open');
  if (focusId) el(focusId).focus({ preventScroll: true });
}

function closeOverlay(id) {
  el(id).classList.remove('is-open');
  if (_focusBeforeOverlay && document.contains(_focusBeforeOverlay)) {
    _focusBeforeOverlay.focus({ preventScroll: true });
  }
  _focusBeforeOverlay = null;
}

function toast(message) {
  const t = el('toast');
  t.textContent = message;
  t.classList.add('is-showing');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('is-showing'), TOAST_MS);
}

// ---------------------------------------------------------------------------
// the round
// ---------------------------------------------------------------------------
// a new round always opens with a 3-2-1 so the poet has the phone in hand
// before the clock starts eating their time
async function startRound() {
  stopRound();
  closeOverlay('roundOver');
  state.score = 0;
  renderScore();
  renderTimer(state.roundSeconds * 1000);
  el('wordOne').textContent = 'Get ready';
  el('wordThree').textContent = '';

  const finished = await runCountdown();
  if (!finished) return;

  state.running = true;
  _shownSeconds = -1; // re-render so a short round shows as urgent from the first second
  showCard(drawCard());
  _roundEndsAt = performance.now() + state.roundSeconds * 1000;
  _frame = requestAnimationFrame(tick);
  holdScreenAwake();
}

// anything that leaves a round early goes through here, so a stale countdown
// or timer can never fire into the next one
function stopRound() {
  state.running = false;
  _countdownToken++;
  cancelAnimationFrame(_frame);
  el('countdown').classList.remove('is-open');
  releaseScreen();
}

function endRound() {
  stopRound();
  navigator.vibrate?.(TIME_UP_VIBRATE);
  el('finalScore').textContent = String(state.score);
  openOverlay('roundOver', 'nextTeamBtn');
}

// the deadline is wall-clock (performance.now), not a count of setInterval
// ticks. browsers throttle intervals in background tabs, so counting ticks
// let the old timer drift and run long if the phone so much as glanced away
function tick() {
  if (!state.running) return;
  const msLeft = Math.max(0, _roundEndsAt - performance.now());
  renderTimer(msLeft);
  if (msLeft <= 0) {
    endRound();
    return;
  }
  _frame = requestAnimationFrame(tick);
}

function renderTimer(msLeft) {
  const fraction = msLeft / (state.roundSeconds * 1000);
  el('fuseFill').style.transform = `scaleX(${fraction})`;
  const seconds = Math.ceil(msLeft / 1000);
  if (seconds === _shownSeconds) return;
  _shownSeconds = seconds;
  const urgent = state.running && seconds <= URGENT_S;
  el('timeValue').textContent = String(seconds);
  el('timeValue').classList.toggle('is-urgent', urgent);
  el('fuse').classList.toggle('is-urgent', urgent);
}

function renderScore(delta = 0) {
  const value = el('scoreValue');
  value.textContent = String(state.score);
  if (!delta || reducedMotion()) return;
  // resolved up front, var() inside Web Animations keyframes isn't dependable
  const flash = getComputedStyle(document.documentElement)
    .getPropertyValue(delta < 0 ? '--bonk' : '--three').trim();
  value.animate([
    { transform: 'scale(1)' },
    { transform: 'scale(1.45)', color: flash },
    { transform: 'scale(1)' },
  ], { duration: 380, easing: 'ease-out' });
}

function runCountdown() {
  const token = ++_countdownToken;
  const steps = ['3', '2', '1', 'Go!'];
  const num = el('countdownNum');
  el('countdown').classList.add('is-open');

  return new Promise((resolve) => {
    let i = 0;
    let done = false;
    const finish = (ok) => {
      if (done) return; // a skip already finished it, so the pending step stops here
      done = true;
      el('countdown').removeEventListener('click', skip);
      if (token === _countdownToken) el('countdown').classList.remove('is-open');
      resolve(ok);
    };
    const skip = () => { if (token === _countdownToken) finish(true); };
    el('countdown').addEventListener('click', skip);

    const step = () => {
      if (done) return;
      if (token !== _countdownToken) return finish(false);
      if (i === steps.length) return finish(true);
      num.textContent = steps[i++];
      num.classList.remove('is-popping');
      void num.offsetWidth;
      num.classList.add('is-popping');
      setTimeout(step, COUNTDOWN_STEP_MS);
    };
    step();
  });
}

// ---------------------------------------------------------------------------
// scoring and card effects
// ---------------------------------------------------------------------------
function scoreCard(points, button) {
  if (!state.running) return;
  const now = performance.now();
  if (now - _lastTapAt < TAP_COOLDOWN_MS) return;
  _lastTapAt = now;

  state.score += points;
  renderScore(points);
  floatPoints(button, points);
  if (points < 0) bonk();
  showCard(drawCard(), points < 0 ? 'mad' : 'glad');
}

// the outgoing card is a copy thrown off the table (up and away for points,
// down into the pile for a bonk) while the real one deals the next card
// underneath it. copies mean rapid taps throw several at once, no queueing
function showCard(card, exit) {
  const cardEl = el('card');
  if (exit && !reducedMotion()) flingCopy(cardEl, exit);

  el('wordOne').textContent = card['1'] ?? '';
  el('wordThree').textContent = card['3'] ?? '';

  if (reducedMotion()) return;
  cardEl.animate([
    { opacity: 0, transform: 'translateY(28px) scale(.88) rotate(-2deg)' },
    { opacity: 1, transform: 'none' },
  ], { duration: 420, easing: 'cubic-bezier(.2, .9, .3, 1.25)' });
}

function flingCopy(cardEl, exit) {
  const copy = cardEl.cloneNode(true);
  // ids have to stay unique, and a card mid-air shouldn't be read out again
  copy.removeAttribute('id');
  copy.removeAttribute('aria-live');
  copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  copy.setAttribute('aria-hidden', 'true');
  copy.classList.add('card-ghost');
  el('cardSlot').appendChild(copy);

  const flyTo = exit === 'glad'
    ? 'translate(75%, -45%) rotate(20deg) scale(.85)'
    : 'translate(-15%, 70%) rotate(-14deg) scale(.8)';
  copy.animate([
    { transform: 'none', opacity: 1 },
    { transform: flyTo, opacity: 0 },
  ], { duration: 460, easing: 'cubic-bezier(.5, 0, .75, .3)' }).finished
    .catch(() => {})
    .finally(() => copy.remove());
}

function floatPoints(button, points) {
  if (reducedMotion()) return;
  const float = document.createElement('span');
  float.className = 'float-pts';
  float.textContent = points > 0 ? `+${points}` : String(points).replace('-', '\u2212');
  float.setAttribute('aria-hidden', 'true');
  button.appendChild(float);
  float.animate([
    { transform: 'translate(-50%, 0) scale(.6)', opacity: 0 },
    { transform: 'translate(-50%, -48px) scale(1.2)', opacity: 1, offset: .3 },
    { transform: 'translate(-50%, -110px) scale(1)', opacity: 0 },
  ], { duration: 820, easing: 'ease-out' }).finished
    .catch(() => {})
    .finally(() => float.remove());
}

function bonk() {
  navigator.vibrate?.(BONK_VIBRATE_MS);
  const screen = el('gameScreen');
  const pop = el('bonkPop');
  screen.classList.remove('is-bonked');
  pop.classList.remove('is-showing');
  void pop.offsetWidth; // restart both animations if the last bonk hasn't finished
  screen.classList.add('is-bonked');
  pop.classList.add('is-showing');
}

// ---------------------------------------------------------------------------
// keeping the phone awake
// ---------------------------------------------------------------------------
// without this a phone dims and locks partway through a 60 s round while the
// poet is busy talking. wake lock needs https (or localhost) and isn't in
// every browser, so the worst a failure here does is let the screen dim
async function holdScreenAwake() {
  if (!('wakeLock' in navigator) || _wakeLock) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch { /* denied or the tab isn't visible, the round carries on regardless */ }
}

function releaseScreen() {
  if (!_wakeLock) return;
  _wakeLock.release().catch(() => {});
  _wakeLock = null;
}

// the browser drops the lock whenever the tab is hidden, so take it back when
// the poet returns mid-round
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) holdScreenAwake();
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
el('timeDown').addEventListener('click', () => nudgeRoundSeconds(-ROUND_STEP_S));
el('timeUp').addEventListener('click', () => nudgeRoundSeconds(ROUND_STEP_S));
el('startBtn').addEventListener('click', startGame);

for (const button of document.querySelectorAll('.score-btn')) {
  button.addEventListener('click', () => scoreCard(Number(button.dataset.points), button));
}

el('menuBtn').addEventListener('click', () => {
  if (state.running && !confirm('Leave this round? Its score will be lost.')) return;
  stopRound();
  showScreen('menuScreen');
});
el('restartBtn').addEventListener('click', () => {
  if (state.running && !confirm('Restart this round from zero?')) return;
  startRound();
});

el('nextTeamBtn').addEventListener('click', startRound);
el('optionsBtn').addEventListener('click', () => {
  closeOverlay('roundOver');
  showScreen('menuScreen');
});

const openRules = () => openOverlay('rules', 'rulesCloseBtn');
el('rulesBtn').addEventListener('click', openRules);
el('roundRulesBtn').addEventListener('click', openRules);
el('rulesCloseBtn').addEventListener('click', () => closeOverlay('rules'));
el('rules').addEventListener('click', (e) => { if (e.target === el('rules')) closeOverlay('rules'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el('rules').classList.contains('is-open')) closeOverlay('rules');
});

el('rockLogo').addEventListener('click', (e) => {
  const rock = e.currentTarget;
  rock.classList.remove('is-tumbling');
  void rock.offsetWidth;
  rock.classList.add('is-tumbling');
});
el('rockLogo').addEventListener('animationend', (e) => {
  if (e.animationName === 'rock-tumble') e.currentTarget.classList.remove('is-tumbling');
});

restoreOptions();
