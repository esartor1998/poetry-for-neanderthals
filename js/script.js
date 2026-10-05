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
const OPTIONS_KEY = 'caveman-poetry.options';
const OLD_OPTIONS_KEY = 'vfcm.options';   // from when the site was Verses for Cave Men
const LIGHT_EASE = 0.16;          // share of the gap to the cursor the glow closes per 60 Hz frame
const LIGHT_OFFSET_X = 3;         // px from the torch cursor's hotspot to the middle of its flame
const LIGHT_OFFSET_Y = 7;
const KEY_PRESS_MS = 120;         // how long a keyboard shortcut holds its button down, so you see it land

// keys that score during a round. '-' covers both the main row and the
// numpad, since both report key '-'
const SCORE_KEYS = { '1': '.score-btn.one', '3': '.score-btn.three', '-': '.score-btn.minus', 'b': '.score-btn.minus' };

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
  // falls back to the old key so a returning visitor keeps their options
  // through the rename. the next save writes them under the new key
  try {
    saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? localStorage.getItem(OLD_OPTIONS_KEY));
  } catch { /* defaults it is */ }
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
// the button that was clicked to get here has just gone invisible, and focus
// on a hidden element drops a keyboard or screen reader user back at the top
// of the document. so we hand it to the new screen's heading instead
function showScreen(id) {
  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('is-active', screen.id === id);
  }
  window.scrollTo(0, 0); // Start sits at the bottom of a scrolled menu on small phones
  el(id).querySelector('[tabindex="-1"]')?.focus({ preventScroll: true });
}

// these are native <dialog>s, so showModal() traps focus, makes the page
// behind inert and puts focus back where it was on close. we only pick which
// button gets focus first
function openOverlay(id, focusId) {
  const dialog = el(id);
  if (!dialog.open) dialog.showModal();
  if (focusId) el(focusId).focus({ preventScroll: true });
}

function closeOverlay(id) {
  const dialog = el(id);
  if (dialog.open) dialog.close();
}

function toast(message) {
  const t = el('toast');
  t.textContent = message;
  t.classList.add('is-showing');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('is-showing'), TOAST_MS);
}

// polite, off-screen status line for things a screen reader would otherwise
// miss: the score changing and the clock getting low. cleared first, so the
// same message twice in a row still gets read the second time
function announce(message) {
  const status = el('announcer');
  status.textContent = '';
  requestAnimationFrame(() => { status.textContent = message; });
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
  el('cardNo').textContent = '';

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
  closeOverlay('countdown');
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

// the fuse's fill and flame both hang off --left in the CSS, so one custom
// property per frame moves the pair of them
function renderTimer(msLeft) {
  const fraction = msLeft / (state.roundSeconds * 1000);
  el('fuse').style.setProperty('--left', fraction.toFixed(4));
  const seconds = Math.ceil(msLeft / 1000);
  if (seconds === _shownSeconds) return;
  _shownSeconds = seconds;
  const urgent = state.running && seconds <= URGENT_S;
  el('timeValue').textContent = String(seconds);
  el('timeValue').classList.toggle('is-urgent', urgent);
  el('fuse').classList.toggle('is-urgent', urgent);
  // only when the clock crosses the line, not on a round that starts short
  if (urgent && seconds === URGENT_S && seconds < state.roundSeconds) {
    announce(`${URGENT_S} seconds left.`);
  }
}

function renderScore(delta = 0) {
  const value = el('scoreValue');
  value.textContent = String(state.score);
  if (!delta || reducedMotion()) return;
  // resolved up front, var() inside Web Animations keyframes isn't dependable
  const flash = getComputedStyle(document.documentElement)
    .getPropertyValue(delta < 0 ? '--flash-bad' : '--flash-good').trim();
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
  openOverlay('countdown', 'skipCountdownBtn');

  return new Promise((resolve) => {
    let i = 0;
    let done = false;
    const finish = (ok) => {
      if (done) return; // a skip already finished it, so the pending step stops here
      done = true;
      el('countdown').removeEventListener('click', skip);
      if (token === _countdownToken) closeOverlay('countdown');
      resolve(ok);
    };
    // the dialog fills the screen, so this catches the Skip button (the
    // click bubbles up) and a tap anywhere else alike
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
  announce(`${points > 0 ? 'Plus' : 'Minus'} ${Math.abs(points)}. Score ${state.score}.`);
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
  el('cardNo').textContent = `No. ${state.cardIndex}`;

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
  copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  copy.querySelectorAll('[aria-live]').forEach((node) => node.removeAttribute('aria-live'));
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
// torchlight
// ---------------------------------------------------------------------------
// with a mouse, the light comes from the torch cursor. it eases after the
// pointer instead of sticking to it, so it feels carried rather than pinned
// on. touch screens have no cursor between taps, so the glow stays put.
// "is there a mouse" is decided by a real mouse moving, not by asking
// matchMedia('(pointer: fine)'): Firefox on Linux can answer no with a mouse
// plugged in, which left the torch dead there
function followTorch() {
  const layers = [...document.querySelectorAll('.torch-layer')];
  if (!layers.length) return;

  // starts where the CSS parks it, so the first move glides from there
  let x = innerWidth / 2;
  let y = innerHeight * 0.12;
  let targetX = x;
  let targetY = y;
  let lastFrameAt = 0;
  let frame = 0;
  const place = () => {
    for (const layer of layers) layer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const step = (now) => {
    const dt = lastFrameAt ? Math.min(64, now - lastFrameAt) : 16.7;
    lastFrameAt = now;
    // scaled by frame time so it trails the same on a 60 Hz or a 144 Hz screen
    const k = 1 - Math.pow(1 - LIGHT_EASE, dt / 16.7);
    x += (targetX - x) * k;
    y += (targetY - y) * k;
    place();
    // idle once it's caught up, rather than running a loop forever for nothing
    if (Math.abs(targetX - x) + Math.abs(targetY - y) > 0.5) {
      frame = requestAnimationFrame(step);
    } else {
      frame = 0;
      lastFrameAt = 0;
    }
  };

  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    document.documentElement.classList.add('has-mouse');
    targetX = e.clientX + LIGHT_OFFSET_X;
    targetY = e.clientY + LIGHT_OFFSET_Y;
    if (reducedMotion()) {
      x = targetX;
      y = targetY;
      place();
      return;
    }
    if (!frame) frame = requestAnimationFrame(step);
  }, { passive: true });
}

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
// the dialog has no padding of its own, so a click whose target is the
// dialog itself came through the backdrop
el('rules').addEventListener('click', (e) => { if (e.target === el('rules')) closeOverlay('rules'); });

// Escape would close these and strand you on a dead game screen: a
// countdown that never finishes, or a round-over sheet gone with no
// Next team button. both are over in a moment or have their own way out
for (const id of ['countdown', 'roundOver']) {
  el(id).addEventListener('cancel', (e) => e.preventDefault());
}

// 1, 3 and B or - score from a keyboard. ignored while typing, while a
// dialog's up, with a modifier held (so browser shortcuts still work) and on
// key repeat (a held key would burn through the deck)
document.addEventListener('keydown', (e) => {
  if (!state.running || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
  const selector = SCORE_KEYS[e.key.toLowerCase()];
  if (!selector) return;
  e.preventDefault();
  const button = document.querySelector(selector);
  button.classList.add('is-pressed');
  setTimeout(() => button.classList.remove('is-pressed'), KEY_PRESS_MS);
  scoreCard(Number(button.dataset.points), button);
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
followTorch();
