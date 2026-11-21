/**
 * engine.js — ядро игры «Текстовый раннер».
 * Вид сбоку, автобег вправо; один тап / пробел = прыжок (Canabalt-механика).
 * Платформы несут фразы резюме: пробежал по платформе — фраза «прочитана».
 *
 * API для router.js:  TextRunner.start() / stop() / restart()
 */
(function () {
  'use strict';

  var D = window.GAME_DATA;
  var FONT = '600 17px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  var canvas, ctx, hudRoot, measureCanvas, measureCtx;
  var W = 0, H = 0;

  var state = null;          // текущий забег
  var started = false, ended = false, paused = false;
  var rafId = null, lastTime = 0;
  var pendingJump = false, jumpRequestAt = 0;
  var boundInput = false, boundResize = false, lastSectionForHud = -1;

  // Kenney Pixel Platformer (CC0), row 1 character sheet — flash-free set
  var playerImgs = null; // {runA, runB, jump}: frames available after loading

  // Kenney ground tiles (CC0): травяная верхняя грань + земляное тело колонн платформ
  var tileImgs = null;  // {grass, dirt}
  var TILE_PX = 42;     // размер тайла на экране — тот же масштаб, что у спрайта игрока
  // геометрия кольев — в GAME_DATA (data.js): spikeW/spikeH/playerHalf,
  // общие для расстановки в level.js и отрисовки/смерти здесь

  function loadTiles() {
    if (tileImgs || typeof Image === 'undefined') return; // smoke/node — нет DOM
    tileImgs = {};
    tileImgs.grass = new Image();
    tileImgs.grass.src = 'assets/img/tiles/grass.png';
    tileImgs.dirt = new Image();
    tileImgs.dirt.src = 'assets/img/tiles/dirt.png';
  }

  function tilesReady() {
    return !!tileImgs &&
      tileImgs.grass.complete && tileImgs.grass.naturalWidth > 0 &&
      tileImgs.dirt.complete && tileImgs.dirt.naturalWidth > 0;
  }

  // Пиксель-арт полоса задника (тайлится по горизонтали: соседние тайлы чередуют обычную и
  // отражённую копию): одна на забег — сначала случайная, дальше по кругу; паритет зеркала
  // тоже случайный на забег.
  var backdrops = null;   // [Image, ...]: доступны после загрузки
  var bgIndex = -1;       // индекс полосы текущего забега (-1 → ещё не выбрано)
  var mirrorPhase = 0;    // паритет зеркала: тайл (j + phase) & 1 === 1 — отражённая копия
  var fillCache = {};      // img.src -> цвет нижнего ряда (заполнение под изображением)
  var mirrorCache = {};    // img.src -> offscreen-канвас с горизонтальным зеркалом

  function loadBackdrops() {
    if (backdrops || typeof Image === 'undefined') return; // smoke/node — нет DOM
    backdrops = [];
    for (var i = 0; i < D.backdrops.length; i++) {
      var img = new Image();
      img.src = D.backdrops[i];
      backdrops.push(img);
    }
  }

  function backdropReady() {
    if (!backdrops) return false;
    for (var k in backdrops) {
      if (!backdrops[k].complete || backdrops[k].naturalWidth <= 0) return false;
    }
    return true;
  }

  /** выбор полосы и паритета зеркала на забег: полоса — сначала случайная, дальше по кругу;
      паритет — случайный (с какой из двух ориентаций начинается чередование по тайлам) */
  function pickBackdrop() {
    var n = D.backdrops.length;
    if (!n) return;
    bgIndex = (bgIndex < 0) ? Math.floor(Math.random() * n) : (bgIndex + 1) % n;
    mirrorPhase = Math.floor(Math.random() * 2);
  }

  /** цвет нижнего ряда полосы — для заполнения под изображением: небо не должно
      просвечивать под задником. Нижний ряд однотонный, поэтому среднее точно;
      взвешивание по альфе страхует от шумов сглаживания. */
  function backdropFillColor(img) {
    var key = img.src;
    if (fillCache[key]) return fillCache[key];
    var c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = 1;
    var cc = c.getContext('2d');
    cc.drawImage(img, 0, img.naturalHeight - 1, img.naturalWidth, 1, 0, 0, img.naturalWidth, 1);
    var d = cc.getImageData(0, 0, img.naturalWidth, 1).data;
    var r = 0, g = 0, b = 0, a = 0;
    for (var i = 0; i < d.length; i += 4) {
      var al = d[i + 3];
      r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
    }
    if (!a) return fillCache[key] = '#000';
    var hex = function (v) {
      v = Math.max(0, Math.min(255, Math.round(v / a)));
      return ('0' + v.toString(16)).slice(-2);
    };
    return fillCache[key] = '#' + hex(r) + hex(g) + hex(b);
  }

  /** горизонтальное зеркало полосы — offscreen-канвас, строится один раз на src.
      Browser-only: вызывается только при backdropReady() (в node Image не определён). */
  function mirroredCanvas(img) {
    var key = img.src;
    if (!mirrorCache[key]) {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      var cc = c.getContext('2d');
      cc.translate(c.width, 0);
      cc.scale(-1, 1);
      cc.drawImage(img, 0, 0);
      mirrorCache[key] = c;
    }
    return mirrorCache[key];
  }

  /* ---------- геометрия ---------- */

  var lastDpr = 0; // dpr, использованный при последнем resize — ловим смену zoom/монитора

  function resize() {
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    // no-op-защита: если backing-store и dpr не изменились — не сбрасываем канвас.
    // Сброс canvas.width/height очищает контекст и может «мигнуть» сценой
    // (причина моргания на HiDPI-машинах при смене devicePixelRatio).
    if (dpr === lastDpr && canvas.width === Math.round(W * dpr) && canvas.height === Math.round(H * dpr)) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lastDpr = dpr;
  }

  /** базовая линия мира — верхняя грань платформы с lift = 0 (первой) */
  function groundTop() {
    return H - D.groundFromBottom;
  }

  /** верхняя грань конкретной платформы (базовая линия минус её подъём, плюс общий подъём на строку текста) */
  function platTop(q) {
    return groundTop() - q.lift - D.platformRaise;
  }

  /* ---------- спрайты игрока (Kenney Pixel Platformer, CC0) ----------
     Row 1 of the sheet: run-цикл c0/c1 ; прыжковый кадр = c0 (у персонажа в пакете нет отдельной позы — переиспользуем run-кадр) — все кадры на одной палитре,
     поэтому нет цветового «мигания» при смене кадров. Fallback — капсула. */

  function loadPlayerSprites() {
    if (playerImgs || typeof Image === 'undefined') return; // smoke/node — нет DOM
    var srcs = [
      ['runA', 'assets/img/player/run_a.png'],
      ['runB', 'assets/img/player/run_b.png'],
      ['jump', 'assets/img/player/jump.png']
    ];
    playerImgs = {};
    for (var i = 0; i < srcs.length; i++) {
      var img = new Image();
      img.src = srcs[i][1];
      playerImgs[srcs[i][0]] = img;
    }
  }

  function spritesReady() {
    return !!playerImgs &&
      playerImgs.runA.complete && playerImgs.runA.naturalWidth > 0 &&
      playerImgs.runB.complete && playerImgs.runB.naturalWidth > 0 &&
      playerImgs.jump.complete && playerImgs.jump.naturalWidth > 0;
  }

  /* ---------- состояние забега ---------- */

  function buildState() {
    var platforms = window.Level.build(measureCtx);

    // стартовая x-координата каждой секции (для чекпоинтов и HUD)
    var sectionStartX = [];
    D.sections.forEach(function (_, si) {
      for (var i = 0; i < platforms.length; i++) {
        if (platforms[i].section === si) { sectionStartX.push(platforms[i].x); break; }
      }
    });

    // последняя платформа продолжается за свою фразу («дорога не обрывается»),
    // чтобы после финиша не было уступа: finishX — по исходному краю фразы
    var lastP = platforms[platforms.length - 1];
    var finishX = lastP.end;
    lastP.w += 500;

    state = {
      finishX: finishX,
      platforms: platforms,
      sectionStartX: sectionStartX,
      player: {
        x: Math.min(70, platforms[0].w * 0.4),
        feetY: platTop(platforms[0]),
        vy: 0,
        grounded: true
      },
      lastGroundedAt: performance.now(),
      jumpUsed: false, // один буферный прыжок за контакт с землёй
      sectionIndex: 0,
      readTotal: 0,
      misses: 0,
      elapsed: 0,
      sectionEnterAt: 0, // game-time входа в текущую секцию (тайминг надписи)
      lastStepTick: -1,  // ритм шагов привязан к циклу run-спрайта (~7 fps)
      phraseCount: 0     // сколько «читаемых» платформ (без intro-платформ)
    };
    for (var pc = 0; pc < platforms.length; pc++) {
      if (!platforms[pc].intro) state.phraseCount++;
    }
    lastSectionForHud = -1;
  }

  /** платформа под координатой x (или null, если её нет) */
  function platformUnder(x) {
    for (var i = 0; i < state.platforms.length; i++) {
      var q = state.platforms[i];
      if (x >= q.x - 8 && x <= q.x + q.w + 8) return q;
    }
    return null;
  }

  function respawn() {
    state.misses++;
    var p0 = null;
    for (var i = 0; i < state.platforms.length; i++) {
      if (state.platforms[i].section === state.sectionIndex) { p0 = state.platforms[i]; break; }
    }
    // спавн по центру первой платформы секции (не на её краю — оттуда сразу уклон),
    // и не в смертельной зоне колышка: если рядом стоит один, сдвигаемся на свободную
    // сторону (два колышка ближе 2·(hw+pH) друг к другу placement не ставит)
    var sx = p0.x + p0.w * 0.5;
    for (var sI2 = 0; sI2 < (p0.spikes || []).length; sI2++) {
      var skx = p0.spikes[sI2].x;
      if (Math.abs(sx - skx) < D.spikeW / 2 + D.playerHalf + 16) {
        sx += (skx <= sx) ? D.spikeW / 2 + D.playerHalf + 30 : -(D.spikeW / 2 + D.playerHalf + 30);
      }
    }
    state.player.x = Math.max(p0.x + 8, Math.min(p0.end - 8, sx));
    state.player.feetY = platTop(p0);
    state.player.vy = 0;
    state.player.grounded = true;
    state.lastGroundedAt = performance.now();
    state.jumpUsed = false;
    pendingJump = false; // тап до падения не «переносится» через респаун
  }

  function markRead(q) {
    q.read = true;
    state.readTotal++;
    var secTitle = D.sections[q.section].title;
    var doneAll = true;
    for (var i = 0; i < state.platforms.length; i++) {
      if (state.platforms[i].section === q.section && !state.platforms[i].read) { doneAll = false; break; }
    }
    if (doneAll) window.Hud.toast('Секция «' + secTitle + '» прочитана', 2000);
  }

  /* ---------- обновление мира ---------- */

  function update(dt, now) {
    var p = state.player;
    state.elapsed += dt;

    // секция по позиции (с небольшим «выглядыванием» вперёд)
    var si = 0;
    for (var i = state.sectionStartX.length - 1; i >= 0; i--) {
      if (p.x >= state.sectionStartX[i] - 20) { si = i; break; }
    }
    if (si !== state.sectionIndex) {
      state.sectionIndex = si;
      // вход в новую секцию — перезапуск анимации надписи (game-time,
      // поэтому на паузе замирает вместе с забегом) + искры цвета секции
      state.sectionEnterAt = state.elapsed;
      if (window.Fx) window.Fx.section(D.sections[si].hue, p.x, p.feetY - 20);
    }

    var speed = D.speedBase + state.sectionIndex * D.speedPerSection;
    p.x += speed * dt;

    // прыжок: буфер ввода + койот-тайм для честного ощущения на мобильном.
    // Не более одного «буферного» прыжка за один контакт с землёй —
    // иначе койот-окно сразу после отрыва «перепрыгивает» второй раз.
    var canJump = p.grounded || (!state.jumpUsed && now - state.lastGroundedAt <= D.coyoteMs);
    if (canJump && pendingJump && now - jumpRequestAt <= D.jumpBufferMs) {
      p.vy = -D.jumpVelocity;
      p.grounded = false;
      pendingJump = false;
      state.jumpUsed = true;
      if (window.Fx) window.Fx.jump(p.x, p.feetY);
    }

    // вертикальная физика и приземление (по верхней грани конкретной платформы)
    if (!p.grounded) {
      var prevFeet = p.feetY;
      p.vy += D.gravity * dt;
      if (p.vy > 1500) p.vy = 1500; // терминальная скорость — против «туннелирования»
      p.feetY += p.vy * dt;

      var under = platformUnder(p.x);
      if (under && p.vy >= 0 && prevFeet <= platTop(under) + 0.5 && p.feetY >= platTop(under)) {
        p.feetY = platTop(under);
        p.vy = 0;
        p.grounded = true;
        state.lastGroundedAt = now;
        state.jumpUsed = false;
        if (window.Fx) window.Fx.land(p.x, p.feetY); // пыль + лёгкая тряска камеры
      }
    } else if (!platformUnder(p.x)) {
      // сошёл с края платформы — начинаем падение (койот-тайм даёт окно для прыжка)
      p.grounded = false;
    }

    // шаги по земле: звук реже, чем анимация бегущего спрайта (делился бы по ушам),
    // ~4 шага в секунду; делитель в draw() для run-спрайта остаётся 0.14
    var stepTick = Math.floor(state.elapsed / 0.25);
    if (p.grounded && stepTick !== state.lastStepTick) {
      if (window.Fx) window.Fx.step(p.x - 20, p.feetY);
      state.lastStepTick = stepTick;
    }

    // колья на платформах — касание = смерть (как кактусы в динозаврике): AABB бокса
    // игрока и колья. Коль выше поверхности, поэтому достают только бегущего/падающего
    for (var si = 0; si < state.platforms.length; si++) {
      var q2 = state.platforms[si];
      if (!q2.spikes || !q2.spikes.length) continue;
      if (p.x + D.playerHalf < q2.x - D.spikeH || p.x - D.playerHalf > q2.end + D.spikeH) continue; // далеко от платформы
      var stp = platTop(q2);
      for (var sk = 0; sk < q2.spikes.length; sk++) {
        if (Math.abs(p.x - q2.spikes[sk].x) < D.spikeW / 2 + D.playerHalf && p.feetY > stp - D.spikeH) {
          if (window.Fx) window.Fx.death(p.x, p.feetY); // разлёт в точке касания
          respawn();
          return; // игрок сброшен — дальше живём на следующем кадре
        }
      }
    }

    // упал в просвет → небольшой откат к началу текущей секции (без штрафа прогресса)
    if (p.feetY > H + 80) {
      if (window.Fx) window.Fx.death(p.x, H); // разлёт у нижнего края экрана
      respawn();
    }

    // «прочитанные» фразы: платформа полностью пройдена (по исходному краю, q.end)
    for (var j = 0; j < state.platforms.length; j++) {
      var q = state.platforms[j];
      if (!q.read && p.x > q.end) markRead(q);
    }

    // финиш забега: прошёл край последней фразы с небольшим запасом
    if (p.x > state.finishX + 60) finish();
  }

  function finish() {
    ended = true;
    if (window.Fx) window.Fx.finish(state.player.x, H / 2); // фанфары + конфетти
    window.Hud.showEndPanel(
      { time: state.elapsed, misses: state.misses, readTotal: state.readTotal },
      function () { TextRunner.restart(); }
    );
  }

  /* ---------- отрисовка ---------- */

  function hash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /** фоновые «звёзды» — дешёвый параллакс, детерминированный от camX */
  function drawStars(camX, alpha) {
    var layers = [
      { f: 0.12, r: 1, a: 0.35, band: 96 },   // дальние — одиночный пиксель
      { f: 0.30, r: 2, a: 0.45, band: 170 },
      { f: 0.55, r: 3, a: 0.55, band: 300 }   // ближние — 3px-квадрат
    ];
    ctx.fillStyle = '#c2cde6';
    for (var li = 0; li < layers.length; li++) {
      var l = layers[li];
      var off = camX * l.f;
      var i0 = Math.floor(off / l.band);
      ctx.globalAlpha = l.a * alpha;
      for (var i = i0 - 1; i < i0 + W / l.band + 2; i++) {
        var x = Math.round(i * l.band + hash(i * 7.3 + li * 131.7) * l.band - off); // целые пиксели
        var y = Math.round(12 + hash(i * 3.1 + li * 57.3) * H * 0.42);
        ctx.fillRect(x, y, l.r, l.r);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** облака — два параллакс-слоя (дальние мельче и тусклее), детерминированы от camX;
      пиксельные: строки блоков в тон спрайтам */
  function drawClouds(camX, dayness) {
    var layers = [
      { f: 0.18, band: 420, s: 3, yFrac: 0.08, a: 0.16 + 0.10 * dayness }, // дальний (px-шаг 3)
      { f: 0.34, band: 560, s: 5, yFrac: 0.18, a: 0.22 + 0.16 * dayness } // ближний (px-шаг 5)
    ];
    ctx.fillStyle = '#ffffff';
    for (var li = 0; li < layers.length; li++) {
      var l = layers[li];
      var off = camX * l.f;
      var i0 = Math.floor(off / l.band);
      ctx.globalAlpha = l.a;
      for (var i = i0 - 1; i <= i0 + W / l.band + 2; i++) {
        var x = Math.round(i * l.band + hash(i * 9.7 + li * 43.1) * l.band - off); // целые пиксели
        var y = Math.round(H * l.yFrac + hash(i * 5.3 + li * 11.9) * H * 0.08);
        pixelCloud(x, y, l.s);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** одно облако — пиксельная «шапка»: строки блоков [y, x0, w] в px-шагах */
  function pixelCloud(x, y, s) {
    var rows = [
      [0, 2, 3], // верхушка
      [1, 1, 5],
      [2, 0, 7],
      [3, -1, 9] // основание шире — «подушка»
    ];
    for (var r = 0; r < rows.length; r++) {
      ctx.fillRect(x + rows[r][1] * s, y + rows[r][0] * s, rows[r][2] * s, s);
    }
  }

  /** «падающие звёзды» — редкие пиксельные штрихи с хвостом, детерминированные от времени */
  function drawShooting(now, alpha) {
    var n = 3;
    for (var k = 0; k < n; k++) {
      var period = 5200 + k * 1900;
      var t = (now / period) % 1;
      if (t > 0.32) continue; // живёт ~треть периода, остальное время «спит»
      var life = t / 0.32;
      var x = Math.round(W * (0.2 + 0.7 * hash(k * 17.23)) - life * W * 0.85);
      var y = Math.round(H * (0.06 + 0.28 * hash(k * 31.7)) + life * H * 0.24);
      // хвост — пиксели по диагонали вверх-назад; голова ярче и крупнее
      ctx.fillStyle = 'rgba(255,255,255,' + (0.55 * alpha) + ')';
      for (var j = 6; j >= 1; j--) {
        if (j > Math.round(6 * (1 - life))) continue; // хвост короче к концу жизни
        ctx.fillRect(x + j * 3, y - j * 2, 2, 2);
      }
      ctx.fillStyle = 'rgba(255,255,255,' + (0.95 * alpha) + ')';
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
  }

  /** луна или солнце — по времени суток; пиксельные блоки в тон спрайтам */
  function drawBody(kind, alpha) {
    var x = Math.round(W * 0.78);
    var y = Math.round(H * 0.15);
    if (kind === 'moon') {
      pixelCircle(x, y, 34, 4, 'rgba(214,226,255,' + (0.14 * alpha) + ')'); // ореол
      pixelCircle(x, y, 21, 4, '#e9edf7');
      ctx.fillStyle = 'rgba(148,163,197,0.55)'; // кратеры — блоки
      ctx.fillRect(x - 8, y - 6, 4, 4);
      ctx.fillRect(x + 3, y + 4, 4, 4);
      ctx.fillRect(x + 1, y - 10, 4, 4);
    } else {
      var r = 24;
      ctx.fillStyle = 'rgba(255,217,122,' + (0.8 * alpha) + ')'; // лучи — пиксели по 8 направлениям
      for (var k = 0; k < 8; k++) {
        var a = (k / 8) * Math.PI * 2;
        ctx.fillRect(Math.round(x + Math.cos(a) * (r + 8)) - 2, Math.round(y + Math.sin(a) * (r + 8)) - 2, 4, 4);
      }
      pixelCircle(x, y, r + 10, 4, 'rgba(255,217,122,' + (0.16 * alpha) + ')'); // ореол
      pixelCircle(x, y, r, 4, '#ffd98a');
    }
  }

  /** пиксельный круг: сетка блоков s×s, «включены» ячейки внутри радиуса */
  function pixelCircle(cx, cy, rad, s, color) {
    ctx.fillStyle = color;
    var n = Math.ceil(rad / s);
    for (var gy = -n; gy <= n; gy++) {
      for (var gx = -n; gx <= n; gx++) {
        if (gx * gx + gy * gy > (rad / s) * (rad / s)) continue;
        ctx.fillRect(cx + gx * s, cy + gy * s, s, s);
      }
    }
  }

  /** пиксельный колюк-треугольник: тёмный силуэт чуть крупнее + светлый корпус внутри —
      читается на любом фоне. Ступени по 2px, остриё сверху */
  function pixelSpike(cx, yBase) {
    spikeShape(cx, yBase, D.spikeW + 4, D.spikeH + 2, '#394150'); // контур
    spikeShape(cx, yBase, D.spikeW - 4, D.spikeH - 6, '#efe6c8'); // корпус
  }
  function spikeShape(cx, yBase, w, h, color) {
    if (w < 2 || h < 2) return;
    ctx.fillStyle = color;
    var s = 2, rows = Math.round(h / s);
    for (var r = 0; r < rows; r++) { // r=0 — остриё
      var rw = Math.max(s, Math.ceil((w * (r + 1)) / rows / s) * s);
      ctx.fillRect(Math.round(cx - rw / 2), yBase - h + r * s, rw, s);
    }
  }

  /** дальний план: одна пиксель-арт полоса на забег (тайлится по горизонтали): соседние тайлы
      чередуют обычную и отражённую копию — каждый стык становится «зеркальным» и не виден.
      Масштаб из GAME_DATA (нативный размер большеваты), пиксели чёткие. Нижний край
      приподнят над линией горизонта, поэтому холмы выглядывают из-за платформ; под изображением
      закрашиваем его собственным цветом нижнего ряда: небо не просвечивает под задником.
      В node-smoke DOM нет → функция ничего не рисует (только небо выше). */
  function drawParallax(camX) {
    if (!backdropReady()) return; // browser-only: в node Image не определён
    var img = backdrops[bgIndex];
    // целые пиксели — без субпиксельных швов на стыке тайлов и под нижним краем
    var iw = Math.round(img.naturalWidth * D.backdropScale);
    var ih = Math.round(img.naturalHeight * D.backdropScale);
    var bottomY = Math.round(groundTop() - D.platformRaise - D.backdropLift); // чуть выше горизонта
    ctx.imageSmoothingEnabled = false;
    var scroll = camX * D.backdropParallax; // параллакс: полоса скользит медленнее камеры
    var j0 = Math.floor(scroll / iw);      // мировой индекс тайла у левого края экрана
    var off = scroll - j0 * iw;            // его смещение на экране, в [0, iw)
    for (var i = 0; ; i++) {
      var x = Math.round(off + i * iw);
      if (x >= W + iw) break;             // за правым краем экрана
      // паритет стабилен при движении камеры: (j + phase) & 1 === 1 — отражённая копия той же полосы
      var src = (((j0 + i + mirrorPhase) & 1) === 1) ? mirroredCanvas(img) : img;
      ctx.drawImage(src, x, bottomY - ih, iw, ih);
    }
    // под полосой — её же цвет нижнего ряда; старт на 1px выше кромки — без светящейся щели
    ctx.fillStyle = backdropFillColor(img);
    ctx.fillRect(0, bottomY - 1, W, H + 24 - bottomY);
  }

  /** палитра неба по времени суток (локальный час) */
  function skyPalette() {
    var h = new Date().getHours();
    if (h >= 9 && h < 17) return { top: '#6fa9e0', bot: '#d3e4f2', stars: 0.10, cl: 1.0, body: 'sun' }; // день
    if (h >= 5 && h < 9) return { top: '#2a3050', bot: '#e0926b', stars: 0.75, cl: 0.7, body: 'sun' };   // утро
    if (h >= 17 && h < 21) return { top: '#2c2a4d', bot: '#c4687e', stars: 0.85, cl: 0.5, body: 'moon' }; // вечер
    return { top: '#0a0e18', bot: '#151c2e', stars: 1, cl: 0.25, body: 'moon' };                            // ночь
  }

  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** один easing для входа и выхода надписи секции (easeInOutCubic) */
  function titleEase(t) {
    t = Math.max(0, Math.min(1, t));
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /** Крупное название секции над intro-платформой:
      влетает с правого края экрана → держится → улетает влево.
      Якорь по центру экрана (над сплошной платформой), тайминг — от game-time
      (state.elapsed − state.sectionEnterAt): на паузе анимация замирает. */
  function drawSectionTitle() {
    var q = null; // intro-платформа текущей секции
    for (var i = 0; i < state.platforms.length; i++) {
      if (state.platforms[i].intro && state.platforms[i].section === state.sectionIndex) {
        q = state.platforms[i]; break;
      }
    }
    if (!q) return;

    var sec = D.sections[q.section];
    var size = Math.max(30, Math.min(58, W * 0.1));
    ctx.font = '800 ' + size + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    var tSec = state.elapsed - state.sectionEnterAt;
    var tin = D.titleInSec, thold = D.titleHoldSec, tout = D.titleOutSec;
    var off; // экранное смещение: вход +W → 0, выход зеркальный 0 → −W (за левый край)
    if (tSec < tin) {
      off = W * (1 - titleEase(tSec / tin));
    } else if (tSec < tin + thold) {
      off = 0;
    } else if (tSec < tin + thold + tout) {
      off = -W * titleEase((tSec - tin - thold) / tout);
    } else {
      return; // анимация завершена — название не показываем
    }

    var cx = W * 0.5 + off;
    var cy = platTop(q) - size * 0.62; // над платформой, на фоне неба
    ctx.shadowColor = 'rgba(8,12,24,0.5)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = 'hsl(' + sec.hue + ', 70%, 72%)';
    ctx.fillText(sec.title, cx, cy);
    ctx.shadowBlur = 0;
    ctx.shadowColor = '';
  }

  function draw(now) {
    // тряска камеры (приземление/смерть): мелкий translate — сцена едет вместе со всем кадром
    var shX = 0, shY = 0;
    if (window.Fx) { var off = window.Fx.offset(); shX = off.x; shY = off.y; }
    ctx.save();
    if (shX || shY) ctx.translate(shX, shY);

    var sky = skyPalette(); // небо подстраивается под время суток (локальный час)
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, sky.top);
    grad.addColorStop(1, sky.bot);
    ctx.fillStyle = grad;
    // запас +8px по краям, чтобы при тряске не было видно «обрезанного» градиента
    ctx.fillRect(-8, -8, W + 16, H + 16);

    var camX = Math.max(0, state.player.x - W * 0.32);
    drawStars(camX, sky.stars);
    drawClouds(camX, sky.cl); // облака: параллакс медленнее звёзд и платформ
    drawShooting(now, sky.stars);
    drawBody(sky.body, sky.stars);

    // дальний план: пиксель-арт полоса задника за платформами (одна на забег, чередуются)
    drawParallax(camX);

    var bottom = H; // платформа доходит до нижнего края экрана — под ней не видно фон

    // платформы-плиты с фразами (каждая по своей высоте)
    for (var i = 0; i < state.platforms.length; i++) {
      var q = state.platforms[i];
      if (q.x > camX + W || q.x + q.w < camX) continue; // вне экрана

      var sx = q.x - camX;
      var qtop = platTop(q);

      if (tilesReady()) {
        // тайлы Kenney: трава сверху + земля ниже; сетка закреплена за миром (не «плавает» при панорамировании)
        ctx.save();
        ctx.beginPath(); // сброс пути: clip не должен накапливать суб-пути предыдущих фигур
        ctx.rect(sx, qtop, q.w, bottom - qtop); // прямые углы (без скругления)
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        var wx0 = Math.floor(q.x / TILE_PX) * TILE_PX; // горизонтальная привязка к мировому гриду
        for (var wy = Math.round(qtop); wy < bottom; wy += TILE_PX) {
          var timg = (wy === Math.round(qtop)) ? tileImgs.grass : tileImgs.dirt;
          for (var wx = wx0; wx < q.x + q.w; wx += TILE_PX) {
            ctx.drawImage(timg, wx - camX, wy, TILE_PX, TILE_PX);
          }
        }
        // «вуаль» адаптивна: днём тоньше (тайлы светлее), ночью плотнее
        ctx.fillStyle = 'rgba(8,10,14,' + (0.2 + 0.25 * sky.stars).toFixed(3) + ')';
        ctx.fillRect(sx, qtop, q.w, bottom - qtop);
        ctx.restore();
      } else {
        ctx.fillStyle = '#1d232c';
        ctx.beginPath();
        ctx.rect(sx, qtop, q.w, bottom - qtop); // прямые углы (без скругления)
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.07)'; // блик верхней грани
        ctx.fillRect(sx + 4, qtop, q.w - 8, 2);
      }

      // текст: по центру плиты (≤ maxLinesPerPlatform строк; intro-платформа без текста)
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(8,12,26,0.55)'; // тень — читаемость при дневной (тонкой) вуали
      ctx.shadowBlur = 4;
      ctx.fillStyle = q.read ? '#9aa4b0' : '#e9edf3'; // прочитанное — тусклее
      // текст опущен на строку: платформа поднята, а фраза теперь на фоне земли (не травы)
      for (var li2 = 0; li2 < q.lines.length; li2++) {
        ctx.fillText(q.lines[li2], sx + q.w / 2, qtop + 20 + D.platformRaise + li2 * 24);
      }
      ctx.shadowBlur = 0;
      ctx.shadowColor = '';
    }

    // колья НА платформах — перепрыгиваемые препятствия (как кактусы в динозаврике):
    // после плит, чтобы полностью стоять на поверхности. Пиксельные и яркие
    // (светлый корпус + тёмный контур) — читаются на зелёном заднике
    for (var spi = 0; spi < state.platforms.length; spi++) {
      var qs = state.platforms[spi];
      if (!qs.spikes || !qs.spikes.length) continue;
      if (qs.x > camX + W || qs.end < camX) continue; // вне экрана
      var qtopK = platTop(qs);
      for (var ski = 0; ski < qs.spikes.length; ski++) {
        pixelSpike(qs.spikes[ski].x - camX, qtopK);
      }
    }

    // крупное название секции над intro-платформой (влетает справа → улетает влево)
    drawSectionTitle();

    // игрок: спрайт Kenney Pixel Platformer (row 1), капсула — fallback
    var p = state.player;
    var px = p.x - camX;
    if (spritesReady()) {
      // jump-кадр в воздухе или при подъёме, run-цикл на земле (~7 fps)
      var jumping = !p.grounded || p.vy < 0;
      var img = jumping ? playerImgs.jump
        : (Math.floor(state.elapsed / 0.14) % 2 === 0 ? playerImgs.runA : playerImgs.runB);
      ctx.imageSmoothingEnabled = false; // чёткие пиксели при масштабе 42/24
      ctx.drawImage(img, px - 21, p.feetY - 42, 42, 42); // бокс 42×42: низ на feetY, центр по player.x
    } else {
      var w = 30, h = 42;
      var squash = Math.min(1.2, Math.max(0.82, 1 - p.vy / 3500));
      var sh = h * squash;
      ctx.fillStyle = '#ffcf5c';
      rr(ctx, px - w / 2, p.feetY - sh, w, sh, 9);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#2a2418'; // «глаза» смотрят вправо — куда бежим
      ctx.beginPath();
      ctx.arc(px + w * 0.16, p.feetY - sh + 11, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // частицы — поверх всего, в мировых координатах (camX тот же, что у платформ)
    if (window.Fx) window.Fx.draw(ctx, camX);

    ctx.restore(); // конец тряски камеры; DOM-HUD translate не нужен

    // HUD
    var sec = D.sections[state.sectionIndex];
    if (state.sectionIndex !== lastSectionForHud) {
      window.Hud.setAccent(sec.hue);
      lastSectionForHud = state.sectionIndex;
    }
    window.Hud.update(
      (state.sectionIndex + 1) + '/' + D.sections.length + ' · ' + sec.title,
      state.readTotal,
      state.phraseCount // только «читаемые» платформы (без intro-платформ)
    );
  }

  /* ---------- цикл ---------- */

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (!started || ended) return; // финал/пауза: кадр замёрзает под панелью
    // devicePixelRatio может смениться БЕЗ resize-события (zoom браузера, перенос окна
    // между мониторами) — тогда backing-store устаревает и сцена «моргает». Ловим
    // каждый кадр дешёвым чтением dpr; сам resize() прервёт no-op.
    var dprNow = Math.min(window.devicePixelRatio || 1, 3);
    if (dprNow !== lastDpr) resize();
    var dt = Math.min((now - lastTime) / 1000, 0.033);
    lastTime = now;
    if (paused) return;
    update(dt, now);
    if (window.Fx) window.Fx.update(dt); // частицы/тряска шагают вместе с миром
    draw(now);
  }

  /* ---------- ввод ---------- */

  function bindResize() {
    if (boundResize) return;
    boundResize = true;
    window.addEventListener('resize', function () { if (started) resize(); });
  }

  function requestJump() {
    pendingJump = true;
    jumpRequestAt = performance.now();
    if (window.Fx) window.Fx.unlock(); // жеста пользователя — момент «разбудить» AudioContext
  }

  function cutJump() {
    // variable jump: отпускание кнопки в подъёме обрезает скорость —
    // короткий тап поднимает примерно на ⅓ полной высоты, удержание — полный прыжок
    var p = state && state.player;
    if (p && p.vy < 0 && -p.vy > D.jumpCutVelocity) p.vy = -D.jumpCutVelocity;
  }

  function togglePause(forceOn) {
    if (!started || ended) return;
    var on = forceOn == null ? !paused : !!forceOn;
    if (on === paused) return;
    paused = on;
    if (paused) {
      window.Hud.hidePanels();
      window.Hud.showPausePanel(function () { resumeGame(); }, function () { TextRunner.restart(); });
    } else {
      resumeGame();
    }
  }

  function resumeGame() {
    paused = false;
    pendingJump = false;
    window.Hud.hidePanels();
    lastTime = performance.now(); // сброс, чтобы dt не «выстрелил» после паузы
  }

  function bindInput() {
    if (boundInput) return;
    boundInput = true;

    window.addEventListener('keydown', function (e) {
      if (!started || ended) return;
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        if (!e.repeat) requestJump(); // удержание не «перезаряжает» прыжок: одно нажатие — один прыжок
      } else if (e.code === 'KeyP' || e.code === 'Escape') {
        togglePause();
      }
    });

    // отпускание Space/↑ — jump-cut (см. cutJump)
    window.addEventListener('keyup', function (e) {
      if (!started || ended) return;
      if (e.code === 'Space' || e.code === 'ArrowUp') cutJump();
    });

    canvas.addEventListener('pointerdown', function (e) {
      if (!started || ended) return;
      if (typeof e.button === 'number' && e.button > 0) return; // только ЛКМ/тап
      e.preventDefault();
      requestJump();
    });

    // отпускание пальца — jump-cut для мобильных тапов
    canvas.addEventListener('pointerup', function () {
      if (!started || ended) return;
      cutJump();
    });

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // мобильный браузер переключил вкладку → автопауза
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && started && !ended && !paused) togglePause(true);
    });
  }

  /* ---------- публичное API ---------- */

  var TextRunner = {
    start: function () {
      canvas = document.getElementById('game-canvas');
      hudRoot = document.getElementById('game-hud');
      ctx = canvas.getContext('2d');
      measureCanvas = document.createElement('canvas');
      measureCanvas.width = 1;
      measureCanvas.height = 1;
      measureCtx = measureCanvas.getContext('2d');

      resize();
      bindResize();
      bindInput();
      loadPlayerSprites();
      loadTiles();
      loadBackdrops();
      pickBackdrop(); // первый забег — случайная полоса и паритет зеркала

      buildState();
      window.Hud.init(hudRoot);
      window.Hud.onPause = function () { togglePause(); };

      started = true;
      ended = false;
      paused = false;
      pendingJump = false;
      lastTime = performance.now();
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(frame);
    },

    stop: function () {
      if (!started) return;
      started = false;
      ended = false;
      paused = false;
      pendingJump = false;
      cancelAnimationFrame(rafId);
      window.Hud.destroy();
      ctx.clearRect(0, 0, W, H);
    },

    restart: function () {
      if (!started) return TextRunner.start();
      ended = false;
      paused = false;
      pendingJump = false;
      pickBackdrop(); // новый забег — следующая полоса по кругу, новый паритет зеркала
      buildState();
      window.Hud.hidePanels();
      lastTime = performance.now();
      window.Hud.toast('Пошёл!', 1400);
    },

    // служебное: доступ к состоянию (используется автотестами tests/smoke.js)
    debug: function () {
      if (!state) return null;
      return {
        player: state.player,
        platforms: state.platforms,
        sectionIndex: state.sectionIndex,
        readTotal: state.readTotal,
        misses: state.misses,
        elapsed: state.elapsed,
        started: started,
        ended: ended,
        paused: paused
      };
    }
  };

  window.TextRunner = TextRunner;
})();
