/**
 * resume.js — читаемая страница резюме (#/resume).
 * Рендерит DOM из window.RESUME: шапка, навыки, «Обо мне», опыт, видео.
 */
(function () {
  'use strict';

  /** маленький помощник для создания элементов */
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** watch-ссылка YouTube → embed */
  function toEmbed(url) {
    try {
      var u = new URL(url);
      if (u.hostname.replace(/^www\./, '') === 'youtube.com' && u.searchParams.has('v')) {
        return 'https://www.youtube-nocookie.com/embed/' + u.searchParams.get('v');
      }
    } catch (e) { /* не YouTube — оставляем как есть */ }
    return url;
  }

  window.Resume = {
    render: function () {
      var root = document.getElementById('resume-root');
      if (!root) return;
      var data = window.RESUME;
      root.innerHTML = '';

      /* --- шапка --- */
      var header = el('header', 'resume-header');
      var h1 = el('h1', null, data.name);
      header.appendChild(h1);
      header.appendChild(el('p', 'resume-role', data.role));
      root.appendChild(header);

      /* --- навыки --- */
      var chips = el('ul', 'skill-chips');
      data.skills.forEach(function (s) {
        chips.appendChild(el('li', null, s));
      });
      root.appendChild(chips);

      /* --- обо мне --- */
      var about = el('section', 'resume-about');
      about.appendChild(el('h2', null, 'Обо мне'));
      var aboutList = el('ul');
      data.about.forEach(function (line) {
        aboutList.appendChild(el('li', null, line));
      });
      about.appendChild(aboutList);
      root.appendChild(about);

      /* --- опыт --- */
      var expSection = el('section', 'resume-experience');
      expSection.appendChild(el('h2', null, 'Опыт'));
      data.experience.forEach(function (item) {
        var card = el('div', 'exp-card');
        card.appendChild(el('h3', null, item.title));
        if (item.period) card.appendChild(el('span', 'exp-period', item.period));
        if (item.intro) card.appendChild(el('p', 'exp-intro', item.intro));

        if (Array.isArray(item.items)) {
          var list = el('ul', 'bullets');
          item.items.forEach(function (line) {
            var li;
            if (typeof line === 'string') {
              li = el('li', null, line);
            } else {
              li = document.createElement('li');
              li.appendChild(el('b', null, line.label + ':'));
              li.appendChild(document.createTextNode(' '));
              li.appendChild(el('span', null, line.text));
            }
            list.appendChild(li);
          });
          card.appendChild(list);
        }

        if (item.highlight) {
          var hl = el('div', 'exp-highlight');
          hl.appendChild(el('h4', null, item.highlight.title));
          var hlList = el('ul', 'bullets');
          item.highlight.items.forEach(function (it) {
            var li = document.createElement('li');
            li.appendChild(el('b', null, it.label + ':'));
            li.appendChild(document.createTextNode(' '));
            li.appendChild(el('span', null, it.text));
            hlList.appendChild(li);
          });
          hl.appendChild(hlList);
          card.appendChild(hl);
        }

        expSection.appendChild(card);
      });
      root.appendChild(expSection);

      /* --- видео --- */
      if (data.videos && data.videos.length) {
        var videoSection = el('section', 'resume-videos');
        videoSection.appendChild(el('h2', null, 'Видео'));
        data.videos.forEach(function (v) {
          var wrap = el('div', 'video-card'); // класс на обёртке — правило .video-card iframe матчит
          var frame = document.createElement('iframe');
          frame.src = toEmbed(v.url);
          frame.title = v.title;
          frame.loading = 'lazy';
          frame.setAttribute('allow', 'fullscreen');
          wrap.appendChild(frame);
          wrap.appendChild(el('p', 'video-title', v.title));
          videoSection.appendChild(wrap);
        });
        root.appendChild(videoSection);
      }

      /* --- футер: ссылки на меню и в игру --- */
      var footer = el('footer', 'resume-footer');
      footer.appendChild(document.createTextNode('Это резюме можно также пробежать как игру.'));
      var links = el('div', 'resume-footer__links');
      var aGame = el('a', null, 'Играть →');
      aGame.href = '#/game';
      var aHome = el('a', null, 'В меню →');
      aHome.href = '#/';
      links.appendChild(aGame);
      links.appendChild(aHome);
      footer.appendChild(links);
      root.appendChild(footer);
    }
  };
})();
