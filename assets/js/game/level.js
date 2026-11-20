/**
 * level.js — сборка мира игры из фраз data.js.
 * Каждая фраза секции становится платформой: ширина зависит от длины текста,
 * просветы между платформами — случайные, но всегда «перепрыгиваемые».
 * Платформы получают разную высоту (lift — смещение верхней грани
 * от базовой линии): мир не плоский, но любой перепад перепрыгивается.
 *
 * Начало каждой секции — intro-платформа: сплошная длинная, без текста,
 * под ней крупная надпись секции анимируется в engine.js (влетает справа,
 * держится, улетает влево).
 */
(function () {
  'use strict';

  var D = window.GAME_DATA;
  var FONT = '600 17px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  /** перенос текста по словам под ширину maxW (измерения через ctx) */
  function wrapText(ctx, text, maxW) {
    var words = text.split(' ');
    var lines = [];
    var cur = '';
    words.forEach(function (word) {
      var test = cur ? cur + ' ' + word : word;
      if (ctx.measureText(test).width <= maxW) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        cur = word; // слово длиннее maxW — не ломаем, просто своей строкой
      }
    });
    if (cur) lines.push(cur);
    return lines;
  }

  window.Level = {
    /**
     * @param {CanvasRenderingContext2D} measureCtx — контекст для замера текста
     * @returns {Array} платформы: {x, w, h, lift, section, text, lines, read, intro?}
     */
    build: function (measureCtx) {
      measureCtx.font = FONT;

      var platforms = [];
      var x = 0;        // левый край следующей платформы
      var lift = 0;     // подъём предыдущей платформы (ограничивает step-up)
      var curSection = 0;

      /** скорость бега текущей секции */
      function secSpeed() {
        return D.speedBase + curSection * D.speedPerSection;
      }

      /**
       * допустимый интервал зазора для перехода с prevLift на L при ширине w.
       * Игрок ВСЕГДА прыгает (и бот тоже): dh = L − lift (> 0 — цель выше),
       * dLand = v·(v0+√(v0²−2g·dh))/g — дальность до приземления на высоте цели.
       * Движок интегрирует полуявным Эйлером (vy += g·dt; y += vy·dt) — реальный
       * полёт короче идеального на ~4-6px, поэтому верхняя граница зазора
       * dLand − JUMP_MARGIN: отрыв от края, приземление на несколько px ВНУТРИ
       * платформы (гарантия попадания даже с учётом погрешности интеграции).
       * Возвращает [gapLo, gapHi] или null, если переход при этом L неисполним.
       */
      var JUMP_MARGIN = 8;
      function gapRange(L, w, gMin, gMax) {
        var v = secSpeed();
        var dh = L - lift; // > 0 — цель выше
        var disc = D.jumpVelocity * D.jumpVelocity - 2 * D.gravity * dh;
        if (disc < 0) return null; // выше максимального прыжка — недосягаемо в принципе
        var dLand = v * ((D.jumpVelocity + Math.sqrt(disc)) / D.gravity);
        var hi = Math.min(gMax, dLand - JUMP_MARGIN);
        if (hi < gMin) return null;
        return [Math.max(gMin, dLand - w), hi];
      }

      /**
       * выбор lift: только исполнимые варианты (см. gapRange), с вероятностью
       * floatChance — «летающая» (верхняя половина диапазона).
       * Возвращает [lift, gapLo, gapHi]; плоский ход всегда исполним (фолбэк).
       */
      function pickLift(w, gMin, gMax) {
        // базовый подъём (minLift) + добавка: платформа не проваливается ниже,
        // иначе нижние строки фразы уплывают под нижний край экрана
        var lo = Math.max(-D.maxDrop, D.minLift);
        var hi = Math.min(D.maxLift, lift + D.maxStepUp); // не выше предыдущей на maxStepUp
        var feasible = [];
        for (var L = hi; L >= lo; L -= 5) {
          var r = gapRange(L, w, gMin, gMax);
          if (r) feasible.push([L, r[0], r[1]]);
        }
        if (feasible.length === 0) return [lift].concat(gapRange(lift, w, gMin, gMax)); // плоский
        if (Math.random() < D.floatChance) {
          var fly = [];
          for (var i = 0; i < feasible.length; i++) {
            if (feasible[i][0] >= lo + (hi - lo) * 0.5) fly.push(feasible[i]);
          }
          if (fly.length > 0) return fly[Math.floor(Math.random() * fly.length)];
        }
        return feasible[Math.floor(Math.random() * feasible.length)];
      }

      /** обычная платформа с фразой: укладываем в ≤ maxLinesPerPlatform строк */
      function addPhrase(text) {
        var w = D.maxPlatformWidth;
        var lines = wrapText(measureCtx, text, w - 2 * D.textPadX);
        // при лишнем числе строк расширяем до maxWidePlatform
        for (var ww = D.maxPlatformWidth + 80;
             ww <= D.maxWidePlatform && lines.length > D.maxLinesPerPlatform;
             ww += 80) {
          var lns = wrapText(measureCtx, text, ww - 2 * D.textPadX);
          if (lns.length < lines.length) { w = ww; lines = lns; }
        }
        // подгоняем ширину под фактический текст (но не уже minPlatformWidth)
        var maxLineW = 0;
        for (var li = 0; li < lines.length; li++) {
          maxLineW = Math.max(maxLineW, measureCtx.measureText(lines[li]).width);
        }
        w = Math.max(D.minPlatformWidth, Math.ceil(maxLineW) + 2 * D.textPadX);

        var h = Math.max(56, 16 + lines.length * 24); // глубина «плиты» — визуальная
        var pick = pickLift(w, D.gapMin + curSection * 3, D.gapMax + curSection * 3);
        lift = pick[0];
        platforms.push({
          x: x, w: w, end: x + w, h: h, lift: lift,
          section: curSection, text: text, lines: lines, read: false
        });
        var gap = Math.round(pick[1] + Math.random() * (pick[2] - pick[1]));
        x += w + gap;
      }

      D.sections.forEach(function (sec, si) {
        curSection = si;

        // --- intro-платформа начала секции: сплошная длинная, без текста ---
        lift = 0;
        platforms.push({
          x: x, w: D.introPlatformW, end: x + D.introPlatformW, h: 60, lift: 0,
          section: si, text: null, lines: [], read: true, intro: true
        });
        // зазор до intro: сход с предыдущей платформы должен быть исполнимым
        var r = gapRange(0, D.introPlatformW, D.gapMin + si * 3, D.gapMax + si * 3);
        var gap = r ? Math.round(r[0] + Math.random() * (r[1] - r[0]))
                    : D.gapMin + Math.random() * (D.gapMax - D.gapMin) + si * 3;
        x += D.introPlatformW + gap;

        sec.phrases.forEach(function (phrase) {
          addPhrase(phrase);
        });
      });

      /* колья НА платформах — перепрыгиваемые препятствия (как кактусы в динозаврике из хрома):
         0–2 на фразу-платформу, ставятся только там, где ОДИН прыжок зачищает колышек и
         приземляется обратно на ЭТУ ЖЕ платформу. Intro-платформы без кольев: респаун кладёт
         игрока в центр первой платформы секции — точка спавна должна быть чистой.
         Границы выводятся из физики GAME_DATA (те же формулы, что gapRange): чтобы на
         опасной полосе [spx−hw−pH, spx+hw+pH] ноги оставались выше острия (высота c),
         отрыв должен попасть в окно ~110 px шириной — колышек стоит не ближе C_left к
         левому краю и не дальше C_right от правого. Узкая платформа → 0; два колышка
         только с разнесением ≥ F + запас (у каждого свой прыжок). */
      var SPIKE_HW = D.spikeW / 2, PLAYER_PH = D.playerHalf;
      var CLEAR_TOL = 10; // высота над остриём: покрывает дрейф полуявного Эйлера (~4–6 px) и поздний отрыв
      var SPIKE_LAG_MARG = 15; // запас на «последний безопасный отрыв»: квантование кадров —
      // тап засчитывается, а фактический отрыв сдвигается на ~v·dt (≈4 px) позже
      function spikeWindows(v) {
        var v0 = D.jumpVelocity, g = D.gravity, c = D.spikeH + CLEAR_TOL;
        var disc = v0 * v0 - 2 * g * c; // ½g·u² − v0·u + c = 0 → u = (v0 ± √disc)/g
        if (disc < 0) return null; // не зачищается в принципе
        var T = 2 * v0 / g; // полное время прыжка туда-обратно на той же высоте
        return { F: v * T, uLo: (v0 - Math.sqrt(disc)) / g, uHi: (v0 + Math.sqrt(disc)) / g };
      }
      for (var k = 0; k < platforms.length; k++) {
        var qk = platforms[k];
        qk.spikes = [];
        if (qk.intro || k === platforms.length - 1) continue; // intro — точка спавна
        // после падения; последняя платформа — финишная прямая, без кольев
        var vSec = D.speedBase + qk.section * D.speedPerSection;
        var sw = spikeWindows(vSec);
        if (!sw) continue;
        // допустимая полоса центра колышка. Безопасный отрыв — окно
        // [spx+(hw+pH)−v·uHi, spx−(hw+pH)−v·uLo]: ноги выше c на всём пути через
        // опасную полосу. Отсюда: (1) ПОЗДНИЙ отрыв не раньше левого края;
        // (2) приземление с позднего отрыва остаётся ВНУТРИ платформы — бегун
        // зачищает колышек и ещё бежит по земле до просвета.
        var cLeft = SPIKE_HW + PLAYER_PH + sw.uLo * vSec + 6 + SPIKE_LAG_MARG;
        // Прыжок в просвет с отрывом у края предыдущей платформы (такой делает и бот,
        // и человек) уносит ноги до prevEnd − 4 + F — за левый край qk на (F − gap).
        // Коль не ставится ближе этой точки + опасная полоса, чтобы приземление из
        // просвета было чистым и до кола оставался заход на его зачистку:
        var worstLand = platforms[k - 1].end - 4 + sw.F;
        cLeft = Math.max(cLeft, worstLand - qk.x + SPIKE_HW + PLAYER_PH + sw.uLo * vSec + SPIKE_LAG_MARG);
        var cRight = sw.F - (SPIKE_HW + PLAYER_PH) - sw.uLo * vSec - 8 + SPIKE_LAG_MARG;
        var lo = Math.ceil(qk.x + cLeft), hi = Math.floor(qk.end - cRight);
        if (hi <= lo) continue; // слишком узко даже для одного колышка
        var n = Math.random() < D.spikeChance ? 1 : 0;
        if (!n) continue;
        var minSpacing = sw.F + 30; // после приземления с первого прыжка остаётся свой заход на второй
        if (hi - lo >= minSpacing && Math.random() < 0.5) n = 2;
        if (n === 1) {
          qk.spikes.push({ x: Math.round(lo + Math.random() * (hi - lo)) });
        } else {
          var free = hi - lo - minSpacing; // ≥ 0 по проверке выше
          var s1 = Math.round(lo + Math.random() * free);
          qk.spikes.push({ x: s1 }, { x: Math.round(s1 + minSpacing + Math.random() * (hi - s1 - minSpacing)) });
        }
      }

      return platforms;
    }
  };
})();
