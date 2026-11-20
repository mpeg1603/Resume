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

      // кнопка-динамик в главном меню: только иконка, состояние общее с игровыми
      var sndBtn = document.querySelector('#screen-welcome .sound-toggle');
      if (sndBtn && window.Fx) window.Fx.bindSoundButton(sndBtn);
    }
  };

  window.Welcome.init();
})();
