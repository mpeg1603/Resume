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

  /* ---------- геометрия ---------- */

  function resize() {
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** верхняя грань всех платформ (мир плоский: фразы «лежат» на одной высоте) */
  function groundTop() {
    return H - D.groundFromBottom;
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
        feetY: groundTop(),
        vy: 0,
        grounded: true
      },
      lastGroundedAt: performance.now(),
      jumpUsed: false, // один буферный прыжок за контакт с землёй
      sectionIndex: 0,
      readTotal: 0,
      misses: 0,
      elapsed: 0
    };
    lastSectionForHud = -1;
  }

  /** есть ли платформа под координатой x (мир плоский — проверяем только по X) */
  function platformUnder(x) {
    for (var i = 0; i < state.platforms.length; i++) {
      var q = state.platforms[i];
      if (x >= q.x - 8 && x <= q.x + q.w + 8) return true;
    }
    return false;
  }

  function respawn() {
    state.misses++;
    var p0 = null;
    for (var i = 0; i < state.platforms.length; i++) {
      if (state.platforms[i].section === state.sectionIndex) { p0 = state.platforms[i]; break; }
    }
    state.player.x = Math.max(16, p0.x - 40);
    state.player.feetY = groundTop();
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
    state.sectionIndex = si;

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

    // вертикальная физика и приземление
    var top = groundTop();
    if (!p.grounded) {
      var prevFeet = p.feetY;
      p.vy += D.gravity * dt;
      if (p.vy > 1500) p.vy = 1500; // терминальная скорость — против «туннелирования»
      p.feetY += p.vy * dt;

      if (p.vy >= 0 && prevFeet <= top + 0.5 && p.feetY >= top && platformUnder(p.x)) {
        p.feetY = top;
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
  function drawStars(camX) {
    var layers = [ { f: 0.15, r: 1.2, a: 0.26 }, { f: 0.38, r: 1.7, a: 0.4 } ];
    ctx.fillStyle = '#8fa3bd';
    for (var li = 0; li < layers.length; li++) {
      var l = layers[li];
      var off = camX * l.f;
      var band = 240;
      var i0 = Math.floor(off / band);
      ctx.globalAlpha = l.a;
      for (var i = i0 - 1; i < i0 + W / band + 2; i++) {
        var x = i * band + hash(i * 7.3 + li * 131.7) * band - off;
        var y = 12 + hash(i * 3.1 + li * 57.3) * H * 0.4;
        ctx.fillRect(x, y, l.r, l.r);
      }
    }
    ctx.globalAlpha = 1;
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

  function draw() {
    ctx.fillStyle = '#0e1014';
    ctx.fillRect(0, 0, W, H);

    var camX = Math.max(0, state.player.x - W * 0.32);
    drawStars(camX);

    var top = groundTop();
    var bottom = H - 16;

    // платформы-плиты с фразами
    for (var i = 0; i < state.platforms.length; i++) {
      var q = state.platforms[i];
      if (q.x > camX + W || q.x + q.w < camX) continue; // вне экрана

      var sx = q.x - camX;
      var sec = D.sections[q.section];

      ctx.fillStyle = '#1d232c';
      rr(ctx, sx, top, q.w, bottom - top, 8);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.07)'; // блик верхней грани
      ctx.fillRect(sx + 4, top, q.w - 8, 2);

      ctx.fillStyle = 'hsl(' + sec.hue + ', 65%, 58%)'; // акцентный край секции
      ctx.fillRect(sx, top, 4, Math.min(q.h, bottom - top));

      // текст: по центру плиты, 1–2 строки
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = q.read ? '#9aa4b0' : '#e9edf3'; // прочитанное — тусклее
      for (var li2 = 0; li2 < q.lines.length; li2++) {
        ctx.fillText(q.lines[li2], sx + q.w / 2, top + 20 + li2 * 24);
      }
    }

    // игрок: капсула со «взглядом вперёд», лёгкий squash & stretch
    var p = state.player;
    var px = p.x - camX;
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

    // HUD
    var sec = D.sections[state.sectionIndex];
    if (state.sectionIndex !== lastSectionForHud) {
      window.Hud.setAccent(sec.hue);
      lastSectionForHud = state.sectionIndex;
    }
    window.Hud.update(
      (state.sectionIndex + 1) + '/' + D.sections.length + ' · ' + sec.title,
      state.readTotal,
      state.platforms.length
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
    draw();
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
