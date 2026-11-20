/**
 * router.js — hash-роутинг SPA.
 * Маршруты: #/ (лэндинг), #/game (игра), #/resume (страница резюме).
 * Глубокие ссылки (#/game, #/resume) работают без 404 — это один index.html.
 */
(function () {
  'use strict';

  var screens = {
    '#/': document.getElementById('screen-welcome'),
    '#/game': document.getElementById('screen-game'),
    '#/resume': document.getElementById('screen-resume')
  };

  var resumeRendered = false;

  function route() {
    var hash = (location.hash || '#/').replace(/\/+$/, ''); // убираем хвостовый /
    if (!screens[hash]) hash = '#/';

    Object.keys(screens).forEach(function (k) {
      screens[k].classList.toggle('active', k === hash);
    });

    // игра: запускается при входе, останавливается при выходе
    if (hash === '#/game') {
      window.TextRunner.start();
    } else {
      window.TextRunner.stop();
    }

    // резюме рендерим один раз — дальше просто показываем
    if (hash === '#/resume' && !resumeRendered) {
      window.Resume.render();
      resumeRendered = true;
    }
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);

  // engine.js и resume.js грузятся ПОСЛЕ роутера (скрипты в конце <body>) —
  // первый route() откладываем до готовности DOM: глубокие ссылки (#/game,
  // #/resume) при первом открытии раньше падали на undefined TextRunner/Resume
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', route);
  } else {
    route();
  }
})();
