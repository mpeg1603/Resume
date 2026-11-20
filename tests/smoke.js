/**
 * tests/smoke.js — симуляция полного забега в node на DOM/canvas-стабах.
 * Проверяет: физику прыжка, приземление, прогресс «прочитано»,
 * респаун после падения и достижение финиша.
 *
 * Запуск:  node tests/smoke.js
 */
'use strict';

var path = require('path');

/* ---------- единые часы: RAF-таймстампы и performance.now() ----------
   В браузере это одна шкала; в симуляции подменяем performance.now(),
   чтобы буферы ввода (jumpBuffer/coyote) работали корректно. */

var t = 0; // текущее время симуляции, мс
try {
  Object.defineProperty(globalThis, 'performance', {
    value: { now: function () { return t; } },
    configurable: true
  });
} catch (e) {
  console.error('НЕЛЬЗЯ подменить performance.now() — тест требует единых часов');
  process.exit(2);
}

/* ---------- помпа requestAnimationFrame ---------- */

var rafCb = null, rafId = 0;
globalThis.requestAnimationFrame = function (cb) { rafCb = cb; return ++rafId; };
globalThis.cancelAnimationFrame = function () { rafCb = null; };

/* ---------- DOM-стабы ---------- */

function makeEl(tag) {
  var el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    innerHTML: '',
    textContent: null,
    appendChild: function (c) { this.children.push(c); return c; },
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function () {},
    setAttribute: function () {},
    remove: function () {}
  };
  if (String(tag).toLowerCase() === 'canvas') el.getContext = function () { return makeCtx(); };
  return el;
}

/** элемент, который запоминает обработчики (window/canvas/hud-root) */
function capturing(el) {
  el.__h = {};
  el.addEventListener = function (ev, fn) { el.__h[ev] = fn; };
  return el;
}

function makeCtx() {
  var noop = function () {};
  return {
    setTransform: noop, fillRect: noop, clearRect: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, arcTo: noop, closePath: noop, fill: noop, stroke: noop,
    fillText: noop, arc: noop,
    createLinearGradient: function () { return { addColorStop: function () {} }; },
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1, lineWidth: 0,
    // «шрифт» ~8.6 px/символ при 17px — достаточно для геометрии мира
    measureText: function (text) { return { width: String(text).length * 8.6 }; }
  };
}

var canvasEl = capturing({
  clientWidth: 1280,
  clientHeight: 720,
  width: 0, height: 0,
  getContext: function () { return makeCtx(); }
});

var hudEl = capturing(makeEl('div'));
hudEl.querySelectorAll = function () { return []; };

globalThis.document = {
  hidden: false,
  getElementById: function (id) {
    if (id === 'game-canvas') return canvasEl;
    if (id === 'game-hud') return hudEl;
    return null;
  },
  createElement: makeEl,
  addEventListener: function () {}
};

globalThis.window = { GAME_DATA: require(path.join(__dirname, '..', 'assets', 'js', 'data.js')).GAME_DATA };
capturing(globalThis.window);
window.innerWidth = canvasEl.clientWidth;
window.innerHeight = canvasEl.clientHeight;
window.devicePixelRatio = 1;

require(path.join(__dirname, '..', 'assets', 'js', 'game', 'level.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'game', 'hud.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'game', 'engine.js'));

/* ---------- «идеальный» бот: прыгает ровно тогда, когда нужно ---------- */

var D = window.GAME_DATA;
var TOP = canvasEl.clientHeight - D.groundFromBottom; // базовая линия (верхняя грань платформы с lift = 0)

/** меняет «разрешение» канваса и пере-запускает забег под новый размер */
function setSize(w, h) {
  canvasEl.clientWidth = w;
  canvasEl.clientHeight = h;
  window.innerWidth = w;
  window.innerHeight = h;
  TOP = h - D.groundFromBottom; // геометрия мира зависит от H (groundTop)
}

/** сколько intro-платформ в забеге (у них read:true с рождения — в readTotal не входят) */
function introCount(plats) {
  var n = 0;
  for (var i = 0; i < plats.length; i++) if (plats[i].intro) n++;
  return n;
}

// фаза «сознательно не прыгать»: бот молчит, пока нет ни одного падения —
// первый просвет гарантированно промахиваем (не зависит от случайной ширины)
var forceFirstMiss = false;

/** дальность горизонтального полёта до приземления на высоте deltaUp от точки отрыва
    (deltaUp > 0 — цель выше): h(t) = v0·t − g/2·t², корень «на нисходящей» */
function jumpDistance(v, deltaUp) {
  var v0 = D.jumpVelocity, g = D.gravity;
  // (g/2)t² − v0·t + deltaUp = 0 → дискриминант v0² − 2g·deltaUp
  var disc = v0 * v0 - 2 * g * deltaUp;
  if (disc < 0) return Infinity; // такой перепад не перепрыгивается в принципе
  return v * ((v0 + Math.sqrt(disc)) / g);
}

function botStep() {
  var dbg = window.TextRunner.debug();
  if (!dbg || dbg.ended || dbg.paused) return;
  if (forceFirstMiss && dbg.misses === 0) return; // нарочное падение на первом просвете

  var p = dbg.player, plats = dbg.platforms;
  // платформа под игроком и следующая впереди (высоты учитываем через lift)
  var under = null, next = null;
  for (var i = 0; i < plats.length; i++) {
    if (!under && p.x >= plats[i].x - 8 && p.x <= plats[i].x + plats[i].w + 8) under = plats[i];
    if (!next && plats[i].x > p.x + 1) next = plats[i];
  }
  if (under == null || next == null) return;

  var speed = D.speedBase + dbg.sectionIndex * D.speedPerSection;
  // «на земле» или в койот-зоне относительно верхней грани СВОЕЙ платформы
  var topA = TOP - under.lift;
  var groundish = p.grounded || p.feetY <= topA + 14;
  if (!groundish) return;

  // точка отрыва: достаточно рано, чтобы долететь до верха следующей платформы,
  // но не позже края своей (койот-зона короткая — прыгаем ещё «на земле»)
  var dLand = jumpDistance(speed, topA - (TOP - next.lift));
  var at = Math.min(next.x - dLand, under.end - 4);

  if (p.x >= at) {
    window.__h['keydown']({ code: 'Space', preventDefault: function () {} });
  }
}

/* ---------- помпа кадров ---------- */

var FRAME_MS = 1000 / 60;

function pump(maxFrames) {
  var frames = 0;
  while (frames < maxFrames && rafCb) {
    t += FRAME_MS;
    var cb = rafCb;
    rafCb = null;
    if (!cb) break;
    cb(t);
    botStep();
    frames++;
    var dbg = window.TextRunner.debug();
    if (dbg && dbg.ended) break;
  }
  return frames;
}

/* ---------- проверки ---------- */

var failures = [];
function check(cond, msg) {
  console.log((cond ? 'ok   ' : 'FAIL ') + msg);
  if (!cond) failures.push(msg);
}

/* Забег A: без ошибок — ни одного падения, все фразы прочитаны (desktop-размер) */
window.TextRunner.start();
forceFirstMiss = false;
var fa = pump(20000);
var a = window.TextRunner.debug();
check(a && a.ended, 'забег A: финиш достигнут (' + (a ? a.elapsed.toFixed(1) : '?') + ' с, ' + fa + ' кадров)');
check(
  a.readTotal === a.platforms.length - introCount(a.platforms),
  'забег A: все фразы прочитаны (' + a.readTotal + '/' + (a.platforms.length - introCount(a.platforms)) + ')'
);
check(a.misses === 0, 'забег A: без падений (misses=' + a.misses + ')');
check(a.elapsed > 30 && a.elapsed < 180, 'забег A: длительность в разумных пределах (' + a.elapsed.toFixed(1) + ' с)');

/* Забег B: нарочное падение в начале → респаун к чекпоинту, дальше бот добирает */
window.TextRunner.restart();
forceFirstMiss = true; // бот молчит до первого падения — первый просвет промахиваем
var fb = pump(20000);
var b = window.TextRunner.debug();
check(b && b.ended, 'забег B: финиш достигнут после падения (' + (b ? b.elapsed.toFixed(1) : '?') + ' с, ' + fb + ' кадров)');
check(b.misses >= 1, 'забег B: зафиксировано падение (misses=' + b.misses + ')');
check(
  b.readTotal === b.platforms.length - introCount(b.platforms),
  'забег B: все фразы прочитаны (' + b.readTotal + '/' + (b.platforms.length - introCount(b.platforms)) + ')'
);

/* Мобильные прогоны D/E: физика от ширины не зависит, но мир-геометрия и рендер — от H/W;
   проверяем добегаемость на смартфонных размерах (портрет) */
var mobileSizes = [[390, 844], [430, 932]];
for (var mi = 0; mi < mobileSizes.length; mi++) {
  var ms = mobileSizes[mi];
  window.TextRunner.stop();
  setSize(ms[0], ms[1]);
  forceFirstMiss = false;
  window.TextRunner.start();
  var fm = pump(20000);
  var m = window.TextRunner.debug();
  check(m && m.ended, 'мобильный прогон (' + ms[0] + '×' + ms[1] + '): финиш достигнут (' + (m ? m.elapsed.toFixed(1) : '?') + ' с, ' + fm + ' кадров)');
  check(
    m.readTotal === m.platforms.length - introCount(m.platforms),
    'мобильный прогон (' + ms[0] + '×' + ms[1] + '): все фразы прочитаны (' + m.readTotal + '/' + (m.platforms.length - introCount(m.platforms)) + ')'
  );
}

/* Забег C: stop() корректно останавливает цикл */
window.TextRunner.stop();
check(rafCb === null, 'stop(): цикл отрисовки остановлен');
var c = window.TextRunner.debug();
check(c && c.started === false, 'stop(): состояние сброшено (started=' + (c ? c.started : '?') + ')');

console.log(failures.length ? '\nPROVAL: ' + failures.join(', ') : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures.length ? 1 : 0); // не ждём «повисших» toast-timers
