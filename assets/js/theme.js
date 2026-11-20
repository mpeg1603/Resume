/**
 * theme.js — темы сайта (наборы CSS-переменных):
 * Catppuccin Mocha (дефолт), Dracula, Nord, Gruvbox, Tokyo Night.
 * Тема применяется атрибутом <html data-theme="...">, выбор сохраняется в localStorage
 * и восстанавливается инлайном в <head> до первой отрисовки (без «мигания» темы).
 * Кнопки-переключатели .theme-switch (data-theme=имя) подключаются здесь.
 */
(function () {
  'use strict';

  var THEMES = ['catppuccin', 'dracula', 'nord', 'gruvbox', 'tokyonight'];
  var DEFAULT = 'catppuccin';
  var KEY = 'resume-theme';

  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function write(name) {
    try { localStorage.setItem(KEY, name); } catch (e) { /* приватный режим — просто не храним */ }
  }

  function current() {
    var saved = read();
    return THEMES.indexOf(saved) !== -1 ? saved : DEFAULT;
  }

  function applyDoc(name) {
    var root = typeof document !== 'undefined' && document.documentElement;
    if (root && root.setAttribute) root.setAttribute('data-theme', name);
  }

  /** отметить активную кнопку среди .theme-switch */
  function markButtons() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var cur = current();
    var btns = document.querySelectorAll('.theme-switch');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-theme') === cur);
    }
  }

  window.Theme = {
    themes: THEMES,
    get: current,
    set: function (name) {
      if (THEMES.indexOf(name) === -1) name = DEFAULT;
      write(name);
      applyDoc(name);
      markButtons();
    },
    /** переключить на следующую тему (для компактной кнопки в HUD игры) */
    cycle: function () {
      var cur = current();
      var next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      window.Theme.set(next);
      return next;
    }
  };

  /** подключить статические кнопки-переключатели, если они есть в разметке */
  function bind() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var btns = document.querySelectorAll('.theme-switch');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          window.Theme.set(b.getAttribute('data-theme'));
        });
      })(btns[i]);
    }
  }

  applyDoc(current()); // сразу при загрузке — до роутинга и отрисовки экранов
  bind();
  markButtons(); // отметить активную тему на кнопках при первой отрисовке
})();
