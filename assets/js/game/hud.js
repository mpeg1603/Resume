/**
 * hud.js — интерфейс игры поверх канваса:
 *  - верхняя панель: секция, прогресс «прочитано», кнопка паузы;
 *  - тосты («секция прочитана» и т.п.);
 *  - панели: финальный экран (со ссылкой на #/resume) и пауза.
 */
(function () {
  'use strict';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m > 0 ? m + ':' : '') + ('0' + s).slice(-2);
  }

  var Hud = {
    container: null,
    onPause: null, // callback, выставляется engine.js

    init: function (container) {
      this.container = container;
      container.innerHTML = '';

      /* --- верхняя панель --- */
      var topbar = el('div', 'hud-topbar');
      this.sectionLabel = el('span', 'hud-section', '');
      topbar.appendChild(this.sectionLabel);

      var progress = el('div', 'hud-progress');
      this.fill = el('div', 'hud-progress-fill');
      progress.appendChild(this.fill);
      topbar.appendChild(progress);

      this.countEl = el('span', 'hud-count', '');
      topbar.appendChild(this.countEl);

      var pauseBtn = el('button', 'hud-pause-btn', '\u23F8'); // ⏸
      pauseBtn.setAttribute('aria-label', 'Пауза');
      pauseBtn.addEventListener('click', function () {
        if (Hud.onPause) Hud.onPause();
      });
      topbar.appendChild(pauseBtn);

      container.appendChild(topbar);

      /* --- тост --- */
      this.toastEl = el('div', 'hud-toast', '');
      container.appendChild(this.toastEl);
      clearTimeout(this._toastTimer);
    },

    update: function (sectionLabel, readTotal, total) {
      if (!this.container) return;
      var pct = total > 0 ? Math.round((readTotal / total) * 100) : 0;
      this.sectionLabel.textContent = sectionLabel;
      this.countEl.textContent = readTotal + '/' + total;
      this.fill.style.width = pct + '%';
    },

    setAccent: function (hue) {
      if (!this.container || !this.fill) return;
      this.fill.style.background = 'hsl(' + hue + ', 70%, 62%)';
      this.sectionLabel.style.color = 'hsl(' + hue + ', 80%, 78%)';
    },

    toast: function (text, ms) {
      if (!this.toastEl) return;
      var self = this;
      this.toastEl.textContent = text;
      this.toastEl.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function () {
        self.toastEl.classList.remove('show');
      }, ms == null ? 2000 : ms);
    },

    /* ---------- панели ---------- */

    showEndPanel: function (stats, onRestart) {
      var panel = el('div', 'hud-panel');
      var card = el('div', 'hud-panel-card');

      card.appendChild(el('h2', 'hud-panel-title', 'Финиш!'));
      card.appendChild(el(
        'p', 'hud-panel-sub',
        'Ты пробежал по всему резюме — все фразы прочитаны.'
      ));

      var statsRow = el('div', 'hud-stats');
      [
        { v: fmtTime(stats.time), l: 'время' },
        { v: String(stats.misses), l: 'падения' },
        { v: String(stats.readTotal), l: 'фраз прочитано' }
      ].forEach(function (s) {
        var box = el('div', 'hud-stat');
        box.appendChild(el('b', null, s.v));
        box.appendChild(el('span', null, s.l));
        statsRow.appendChild(box);
      });
      card.appendChild(statsRow);

      var actions = el('div', 'hud-panel-actions');

      var toResume = el('a', 'btn btn-primary', 'Посмотреть резюме');
      toResume.href = '#/resume';
      actions.appendChild(toResume);

      var again = el('button', 'btn btn-secondary', 'Забегать ещё раз');
      again.addEventListener('click', function () { onRestart(); });
      actions.appendChild(again);

      var home = el('a', 'btn btn-secondary', 'В меню');
      home.href = '#/';
      actions.appendChild(home);

      card.appendChild(actions);
      panel.appendChild(card);
      this.container.appendChild(panel);
    },

    showPausePanel: function (onResume, onRestart) {
      var panel = el('div', 'hud-panel');
      var card = el('div', 'hud-panel-card');

      card.appendChild(el('h2', 'hud-panel-title', 'Пауза'));
      card.appendChild(el('p', 'hud-panel-sub', 'Резюме ждёт'));

      var actions = el('div', 'hud-panel-actions');
      var resumeBtn = el('button', 'btn btn-primary', 'Продолжить');
      resumeBtn.addEventListener('click', function () { onResume(); });
      actions.appendChild(resumeBtn);

      var toResumeLink = el('a', 'btn btn-secondary', 'К резюме');
      toResumeLink.href = '#/resume';
      actions.appendChild(toResumeLink);

      var restartBtn = el('button', 'btn btn-secondary', 'Начать заново');
      restartBtn.addEventListener('click', function () { onRestart(); });
      actions.appendChild(restartBtn);

      var home = el('a', 'btn btn-secondary', 'В меню');
      home.href = '#/';
      actions.appendChild(home);

      card.appendChild(actions);
      panel.appendChild(card);
      this.container.appendChild(panel);
    },

    hidePanels: function () {
      if (!this.container) return;
      var panels = this.container.querySelectorAll('.hud-panel');
      panels.forEach(function (p) { p.remove(); });
    },

    destroy: function () {
      clearTimeout(this._toastTimer);
      if (this.container) this.container.innerHTML = '';
      this.container = null;
    }
  };

  window.Hud = Hud;
})();
