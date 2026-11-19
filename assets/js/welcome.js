/**
 * welcome.js — лэндинг (#/).
 * Две кнопки по центру: крупная «Играть» (сверху) и меньшая «Резюме» (снизу).
 * Имя и роль подставляются из RESUME — единый источник данных.
 */
(function () {
  'use strict';

  window.Welcome = {
    init: function () {
      var nameEl = document.querySelector('#screen-welcome .welcome-name');
      var roleEl = document.querySelector('#screen-welcome .welcome-role');
      if (nameEl) nameEl.textContent = window.RESUME.name;
      if (roleEl) roleEl.textContent = window.RESUME.role;
    }
  };

  window.Welcome.init();
})();
