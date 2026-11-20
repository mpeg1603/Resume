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

      /** подъём: с вероятностью floatChance — «летающая» (выше среднего) */
      function pickLift() {
        if (platforms.length === 0) return 0;
        var lo = -D.maxDrop;
        var hi = Math.min(D.maxLift, lift + D.maxStepUp); // не выше предыдущей на maxStepUp
        var span = hi - lo;
        if (Math.random() < D.floatChance) {
          var flyLo = lo + span * 0.5; // верхняя половина диапазона
          return Math.round(flyLo + Math.random() * (hi - flyLo));
        }
        return Math.round(lo + Math.random() * span);
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
        lift = pickLift();
        platforms.push({
          x: x, w: w, end: x + w, h: h, lift: lift,
          section: curSection, text: text, lines: lines, read: false
        });
        var gap = D.gapMin + Math.random() * (D.gapMax - D.gapMin) + curSection * 3;
        x += w + gap;
      }

      /** «сложное место»: разбивка фразы по словам на подплатформы */
      function addWordSplit(text) {
        var words = text.split(' ');
        for (var i = 0; i < words.length; i += D.wordChunkWords) {
          var chunk = words.slice(i, i + D.wordChunkWords).join(' ');
          var cw = Math.max(
            D.wordSplitMinW,
            Math.ceil(measureCtx.measureText(chunk).width) + 2 * D.textPadX
          );
          lift = pickLift();
          platforms.push({
            x: x, w: cw, end: x + cw, h: 56, lift: lift,
            section: curSection, text: chunk, lines: [chunk], read: false
          });
          var sgap = D.splitGapMin + Math.random() * (D.splitGapMax - D.splitGapMin);
          x += cw + sgap; // узкие просветы — быстрые перепрыгивания
        }
      }

      D.sections.forEach(function (sec, si) {
        curSection = si;

        // --- intro-платформа начала секции: сплошная длинная, без текста ---
        lift = 0;
        platforms.push({
          x: x, w: D.introPlatformW, end: x + D.introPlatformW, h: 60, lift: 0,
          section: si, text: null, lines: [], read: true, intro: true
        });
        var gap = D.gapMin + Math.random() * (D.gapMax - D.gapMin) + si * 3;
        x += D.introPlatformW + gap;

        sec.phrases.forEach(function (phrase) {
          if (typeof phrase === 'object' && phrase.wordSplit) {
            addWordSplit(phrase.text); // «сложное место» секции
          } else {
            var text = typeof phrase === 'string' ? phrase : phrase.text;
            addPhrase(text);
          }
        });
      });

      return platforms;
    }
  };
})();
