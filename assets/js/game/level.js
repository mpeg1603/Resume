/**
 * level.js — сборка мира игры из фраз data.js.
 * Каждая фраза секции становится платформой: ширина зависит от длины текста,
 * просветы между платформами — случайные, но всегда «перепрыгиваемые».
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
     * @returns {Array} платформы: {x, w, h, section, text, lines, read}
     */
    build: function (measureCtx) {
      measureCtx.font = FONT;

      var platforms = [];
      var x = 0;

      D.sections.forEach(function (sec, si) {
        sec.phrases.forEach(function (text) {
          var maxTextW = D.maxPlatformWidth - 2 * D.textPadX;
          var lines = wrapText(measureCtx, text, maxTextW);

          var maxLineW = 0;
          lines.forEach(function (line) {
            maxLineW = Math.max(maxLineW, measureCtx.measureText(line).width);
          });

          // ширина: под текст с отступами, но в разумных пределах
          var w = Math.round(
            Math.min(D.maxPlatformWidth,
              Math.max(D.minPlatformWidth, Math.ceil(maxLineW) + 2 * D.textPadX))
          );
          // глубина «плиты» — чисто визуальная (1–2 строки текста)
          var h = Math.max(56, 16 + lines.length * 24);

          platforms.push({
            x: x,
            w: w,
            // исходный край фразы: по нему считают «прочитано»,
            // даже если визуальная платформа расширена (последняя)
            end: x + w,
            h: h,
            section: si,
            text: text,
            lines: lines,
            read: false
          });

          // просвет: случайный в допустимых пределах, чуть растёт по секциям
          var gap = D.gapMin + Math.random() * (D.gapMax - D.gapMin) + si * 3;
          x += w + gap;
        });
      });

      return platforms;
    }
  };
})();
