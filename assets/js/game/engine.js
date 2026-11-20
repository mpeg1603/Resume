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

  /* ---------- геометрия ---------- */

  function resize() {
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** базовая линия мира — верхняя грань платформы с lift = 0 (первой) */
  function groundTop() {
    return H - D.groundFromBottom;
  }

  /** верхняя грань конкретной платформы (базовая линия минус её подъём) */
  function platTop(q) {
    return groundTop() - q.lift;
  }

  /* ---------- спрайты игрока (Kenney Pixel Platformer, CC0) ----------
     Row 1 of the sheet: run-цикл c0/c1 + jump-tuck c4 — все кадры на одной палитре,
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
    // спавн по центру первой платформы секции (не на её краю — оттуда сразу уклон)
    state.player.x = p0.x + p0.w * 0.5;
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
      // поэтому на паузе замирает вместе с забегом)
      state.sectionEnterAt = state.elapsed;
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
      }
    } else if (!platformUnder(p.x)) {
      // сошёл с края платформы — начинаем падение (койот-тайм даёт окно для прыжка)
      p.grounded = false;
    }

    // упал в просвет → небольшой откат к началу текущей секции (без штрафа прогресса)
    if (p.feetY > H + 80) respawn();

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
      { f: 0.12, r: 1.1, a: 0.30, band: 96 },
      { f: 0.30, r: 1.5, a: 0.42, band: 170 },
      { f: 0.55, r: 2.1, a: 0.55, band: 300 }
    ];
    ctx.fillStyle = '#a9b8d6';
    for (var li = 0; li < layers.length; li++) {
      var l = layers[li];
      var off = camX * l.f;
      var i0 = Math.floor(off / l.band);
      ctx.globalAlpha = l.a * alpha;
      for (var i = i0 - 1; i < i0 + W / l.band + 2; i++) {
        var x = i * l.band + hash(i * 7.3 + li * 131.7) * l.band - off;
        var y = 12 + hash(i * 3.1 + li * 57.3) * H * 0.42;
        ctx.fillRect(x, y, l.r, l.r);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** «падающие звёзды» — редкие штрихи с хвостом, детерминированные от времени */
  function drawShooting(now, alpha) {
    var n = 3;
    for (var k = 0; k < n; k++) {
      var period = 5200 + k * 1900;
      var t = (now / period) % 1;
      if (t > 0.32) continue; // живёт ~треть периода, остальное время «спит»
      var life = t / 0.32;
      var x = W * (0.2 + 0.7 * hash(k * 17.23)) - life * W * 0.85;
      var y = H * (0.06 + 0.28 * hash(k * 31.7)) + life * H * 0.24;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 * alpha) + ')';
      ctx.lineWidth = 1.6;
      var len = 64 * (1 - life);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len * 0.72, y - len * 0.45);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + (0.9 * alpha) + ')';
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** луна или солнце — по времени суток */
  function drawBody(kind, alpha) {
    var x = W * 0.78;
    var y = H * 0.15;
    if (kind === 'moon') {
      ctx.fillStyle = 'rgba(214,226,255,' + (0.16 * alpha) + ')'; // ореол
      ctx.beginPath();
      ctx.arc(x, y, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e9edf7';
      ctx.beginPath();
      ctx.arc(x, y, 21, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(148,163,197,0.55)'; // кратеры
      ctx.beginPath(); ctx.arc(x - 6, y - 4, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 5, y + 6, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 3, y - 8, 2.2, 0, Math.PI * 2); ctx.fill();
    } else {
      var r = 24;
      ctx.strokeStyle = 'rgba(255,217,122,' + (0.8 * alpha) + ')'; // лучи
      ctx.lineWidth = 3;
      for (var k = 0; k < 8; k++) {
        var a = (k / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5));
        ctx.lineTo(x + Math.cos(a) * (r + 14), y + Math.sin(a) * (r + 14));
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,217,122,' + (0.18 * alpha) + ')'; // ореол
      ctx.beginPath();
      ctx.arc(x, y, r + 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd98a';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** палитра неба по времени суток (локальный час) */
  function skyPalette() {
    var h = new Date().getHours();
    if (h >= 9 && h < 17) return { top: '#6fa9e0', bot: '#d3e4f2', stars: 0.10, body: 'sun' }; // день
    if (h >= 5 && h < 9) return { top: '#2a3050', bot: '#e0926b', stars: 0.75, body: 'sun' };   // утро
    if (h >= 17 && h < 21) return { top: '#2c2a4d', bot: '#c4687e', stars: 0.85, body: 'moon' }; // вечер
    return { top: '#0a0e18', bot: '#151c2e', stars: 1, body: 'moon' };                            // ночь
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
    var tw = ctx.measureText(sec.title).width;

    var tSec = state.elapsed - state.sectionEnterAt;
    var tin = D.titleInSec, thold = D.titleHoldSec, tout = D.titleOutSec;
    var off; // экранное смещение: вход +W → 0, выход 0 → −(ширина+запас)
    if (tSec < tin) {
      off = W * (1 - titleEase(tSec / tin));
    } else if (tSec < tin + thold) {
      off = 0;
    } else if (tSec < tin + thold + tout) {
      off = -(tw + 48) * titleEase((tSec - tin - thold) / tout);
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
    var sky = skyPalette(); // небо подстраивается под время суток (локальный час)
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, sky.top);
    grad.addColorStop(1, sky.bot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    var camX = Math.max(0, state.player.x - W * 0.32);
    drawStars(camX, sky.stars);
    drawShooting(now, sky.stars);
    drawBody(sky.body, sky.stars);

    var bottom = H - 16;

    // платформы-плиты с фразами (каждая по своей высоте)
    for (var i = 0; i < state.platforms.length; i++) {
      var q = state.platforms[i];
      if (q.x > camX + W || q.x + q.w < camX) continue; // вне экрана

      var sx = q.x - camX;
      var sec = D.sections[q.section];
      var qtop = platTop(q);

      ctx.fillStyle = '#1d232c';
      rr(ctx, sx, qtop, q.w, bottom - qtop, 8);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.07)'; // блик верхней грани
      ctx.fillRect(sx + 4, qtop, q.w - 8, 2);

      ctx.fillStyle = 'hsl(' + sec.hue + ', 65%, 58%)'; // акцентный край секции
      ctx.fillRect(sx, qtop, 4, Math.min(q.h, bottom - qtop));

      // текст: по центру плиты (≤ maxLinesPerPlatform строк; intro-платформа без текста)
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = q.read ? '#9aa4b0' : '#e9edf3'; // прочитанное — тусклее
      for (var li2 = 0; li2 < q.lines.length; li2++) {
        ctx.fillText(q.lines[li2], sx + q.w / 2, qtop + 20 + li2 * 24);
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
    var dt = Math.min((now - lastTime) / 1000, 0.033);
    lastTime = now;
    if (paused) return;
    update(dt, now);
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
        requestJump();
      } else if (e.code === 'KeyP' || e.code === 'Escape') {
        togglePause();
      }
    });

    canvas.addEventListener('pointerdown', function (e) {
      if (!started || ended) return;
      if (typeof e.button === 'number' && e.button > 0) return; // только ЛКМ/тап
      e.preventDefault();
      requestJump();
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

      window.Hud.toast('Прыгай по фразам своего резюме!', 2600);
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
