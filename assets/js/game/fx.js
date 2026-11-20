/**
 * fx.js — эффекты «Текстовый раннер»: частицы, тряска камеры и синтезированные
 * звуки (Web Audio) для ходьбы, прыжка, приземления, смерти, входа в секцию и финиша.
 *
 * Без внешних файлов: звук генерируется осцилляторами/шумом на лету, частицы —
 * рисуются прямо на canvas. Загружается до engine.js; движок вызывает Fx.* только
 * при наличии window.Fx (в node-симуляции smoke.js модуль не подгружается и все
 * вызовы становятся no-op). Координаты всех событий приходят из движка в мировых
 * координатах — fx.js сам канвасу не нужен.
 */
(function () {
  'use strict';

  var isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (!isBrowser) return; // node/smoke — ничего не экспортируем

  var particles = [];     // {x,y,vx,vy,g,life,maxLife,size,color}
  var shake = 0;          // амплитуда тряски (px), затухает в update()
  var shakeX = 0, shakeY = 0;
  var audioCtx = null;    // AudioContext — лениво, после жеста пользователя
  var soundOn = false;     // звук выключен по умолчанию — включается кнопкой-динамиком
  var MAX_PARTICLES = 420;

  /* ---------- звук: Web Audio синтез (без файлов) ---------- */

  function ensureAudio() {
    if (!audioCtx && typeof window.AudioContext !== 'undefined') {
      var AC = window.AudioContext || window.webkitAudioContext;
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    // автоплей-политика: контекст «разбуждается» только после жеста пользователя —
    // движок вызывает unlock() из обработчиков ввода (тап / клавиша)
    if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) {} }
    return audioCtx;
  }

  /** тон с огибающей: частота, длительность, громкость, тип осциллятора,
      опциональный глиссандо вверх (slideTo) — для «вжуха» прыжка */
  function tone(freq, dur, vol, type, slideTo) {
    if (!soundOn) return; // звук выключен — ни одного узла не создаём (включая отложенные setTimeout-тоны)
    var ctx = ensureAudio();
    if (!ctx || ctx.state !== 'running') return;
    try {
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.linearRampToValueAtTime(slideTo, t0 + dur * 0.7);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + 0.005); // быстрый нарастание — звук «в момент» прыжка
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch (e) {}
  }

  /** шумовой импульс с затуханием — для «шагов» и ударов;
      cutoff — lowpass-фильтр: срезает верх, чтобы шаг был глухим «тук», а не щелчком */
  function noise(dur, vol, cutoff) {
    if (!soundOn) return; // звук выключен — ни одного узла не создаём
    var ctx = ensureAudio();
    if (!ctx || ctx.state !== 'running') return;
    try {
      var t0 = ctx.currentTime;
      var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.7);
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var chain = src;
      if (cutoff) {
        var f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = cutoff;
        chain.connect(f);
        chain = f;
      }
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      chain.connect(gain).connect(ctx.destination);
      src.start(t0);
    } catch (e) {}
  }

  /* ---------- частицы ---------- */

  function spawn(n, o) {
    for (var i = 0; i < n; i++) {
      if (particles.length >= MAX_PARTICLES) break;
      var a = Math.random() * Math.PI * 2;
      var sp = o.spMin + Math.random() * (o.spMax - o.spMin);
      particles.push({
        x: o.x + (Math.random() - 0.5) * (o.spread || 8),
        y: o.y + (Math.random() - 0.5) * (o.spreadY || 6),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + (o.vyBase || 0),
        g: o.g != null ? o.g : 320,
        life: 0,
        maxLife: o.lifeMin + Math.random() * (o.lifeMax - o.lifeMin),
        size: o.sizeMin + Math.random() * (o.sizeMax - o.sizeMin),
        color: o.color
      });
    }
  }

  function addShake(amount) { shake = Math.max(shake, amount); }

  /* ---------- события-эффекты (координаты — из движка, мировые) ---------- */

  /** ходьба: мелкая пыль у ног + глухой тихий «тук» (lowpass — не бьёт по ушам) */
  function step(x, y) {
    noise(0.045, 0.06, 700);
    spawn(2, { x: x - 6, y: y, spMin: 12, spMax: 40, spread: 10, spreadY: 3, vyBase: -30, g: 260, lifeMin: 0.25, lifeMax: 0.5, sizeMin: 1.5, sizeMax: 3.5, color: 'rgba(220,228,240,0.5)' });
  }

  /** прыжок: вспышка вниз + быстрый восходящий «вжух» в момент отрыва (не на пике) */
  function jump(x, y) {
    tone(340, 0.13, 0.20, 'triangle', 760);
    spawn(6, { x: x, y: y - 4, spMin: 30, spMax: 90, spread: 18, vyBase: -70, g: 300, lifeMin: 0.3, lifeMax: 0.55, sizeMin: 2, sizeMax: 4, color: 'rgba(255,207,92,0.8)' });
  }

  /** приземление: пыль + лёгкая тряска камеры */
  function land(x, y) {
    noise(0.08, 0.26); tone(90, 0.10, 0.18, 'sine');
    addShake(5);
    spawn(8, { x: x, y: y - 2, spMin: 40, spMax: 120, spread: 22, vyBase: -60, g: 340, lifeMin: 0.3, lifeMax: 0.6, sizeMin: 2, sizeMax: 4.5, color: 'rgba(200,210,225,0.7)' });
  }

  /** смерть/падение: разлёт + сильная тряска */
  function death(x, y) {
    noise(0.28, 0.36); tone(150, 0.32, 0.28, 'sawtooth');
    addShake(14);
    spawn(20, { x: x, y: y - 30, spMin: 60, spMax: 220, spread: 30, vyBase: -120, g: 380, lifeMin: 0.4, lifeMax: 0.9, sizeMin: 2.5, sizeMax: 5.5, color: 'rgba(255,120,90,0.85)' });
  }

  /** вход в секцию: цветные искры (по hue) */
  function section(hue, x, y) {
    var h = hue != null ? hue : 205;
    tone(440 * Math.pow(2, ((h % 120) / 60)), 0.28, 0.16, 'triangle');
    setTimeout(function () { tone(440 * 1.5 * Math.pow(2, ((h % 120) / 60)), 0.34, 0.11, 'triangle'); }, 90);
    spawn(14, { x: x, y: y - 20, spMin: 40, spMax: 160, spread: 70, vyBase: -40, g: 200, lifeMin: 0.5, lifeMax: 1.0, sizeMin: 2, sizeMax: 4.5, color: 'hsla(' + h + ',80%,70%,0.9)' });
  }

  /** финиш: фанфары + конфетти */
  function finish(x, y) {
    var notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    for (var i = 0; i < notes.length; i++) {
      (function (f, d) { setTimeout(function () { tone(f, 0.3, 0.2, 'square'); }, d); })(notes[i], i * 110);
    }
    for (var c = 0; c < 4; c++) {
      spawn(16, { x: x + (Math.random() - 0.5) * 320, y: y - Math.random() * 160, spMin: 80, spMax: 260, spread: 40, vyBase: -160, g: 420, lifeMin: 0.7, lifeMax: 1.4, sizeMin: 2.5, sizeMax: 5.5, color: 'hsla(' + Math.floor(Math.random() * 360) + ',85%,68%,0.95)' });
    }
  }

  /* ---------- цикл ---------- */

  function update(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    if (shake > 0) {
      shake = Math.max(0, shake - dt * 34); // затухание за ~⅓ секунды
      shakeX = (Math.random() - 0.5) * shake;
      shakeY = (Math.random() - 0.5) * shake;
    } else { shakeX = 0; shakeY = 0; }
  }

  /** частицы — в мировых координатах; camX передаётся из движка */
  function draw(ctx, camX) {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var t = p.life / p.maxLife;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = p.color;
      var s = p.size * (1 - t * 0.4);
      ctx.fillRect(p.x - camX - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- переключатель звука: кнопки-динамики (только иконка, без текста) ---------- */

  var ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/>' +
    '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
  var ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/>' +
    '<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

  /** иконка и aria-label одной кнопки: «выключить», если звук включён */
  function setSoundIcon(btn) {
    btn.innerHTML = soundOn ? ICON_ON : ICON_OFF;
    btn.setAttribute('aria-label', soundOn ? 'Выключить звук' : 'Включить звук');
    btn.title = soundOn ? 'Выключить звук игры' : 'Включить звук игры';
  }

  /** синхронизирует все кнопки-динамики (верхняя панель, пауза, главное меню) */
  function syncSoundButtons() {
    var btns = document.querySelectorAll('.sound-toggle');
    for (var i = 0; i < btns.length; i++) setSoundIcon(btns[i]);
  }

  /** подвешивает клик на одну кнопку-динамик: состояние глобальное, кнопки обновляются все */
  function bindSoundButton(btn) {
    setSoundIcon(btn);
    btn.addEventListener('click', function () {
      soundOn = !soundOn;
      syncSoundButtons();
    });
  }

  /* ---------- публичное API ---------- */

  var Fx = {
    unlock: ensureAudio, // вызывается движком из жеста пользователя (тап/клавиша)
    update: update,
    draw: draw,
    active: function () { return shake > 0 || particles.length > 0; },
    offset: function () { return { x: shakeX, y: shakeY }; },
    step: step,
    jump: jump,
    land: land,
    death: death,
    section: section,
    finish: finish,
    isSound: function () { return soundOn; },
    setSound: function (on) { soundOn = !!on; syncSoundButtons(); },
    bindSoundButton: bindSoundButton,
    syncSoundButtons: syncSoundButtons
  };

  window.Fx = Fx;
})();
