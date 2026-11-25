// Aplica o tema antes da primeira pintura para evitar flash branco (anti-FOUC).
// Arquivo externo para respeitar a CSP `script-src 'self'` (sem inline script).
(function () {
  'use strict';

  var STORAGE_KEY = 'anne_theme';
  var html = document.documentElement;
  var schemeMeta = document.querySelector('meta[name="color-scheme"]');

  function isTheme(value) {
    return value === 'light' || value === 'dark';
  }

  function storedTheme() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      return isTheme(saved) ? saved : null;
    } catch (e) {
      return null;
    }
  }

  function current() {
    var attr = html.getAttribute('data-theme');
    if (attr !== null) return attr === 'dark' ? 'dark' : 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function syncIcons() {
    var sun = document.getElementById('theme-icon-sun');
    var moon = document.getElementById('theme-icon-moon');
    var isDark = current() === 'dark';
    if (sun) sun.classList.toggle('hidden', !isDark);
    if (moon) moon.classList.toggle('hidden', isDark);
  }

  function apply(theme, persist) {
    if (isTheme(theme)) {
      html.setAttribute('data-theme', theme);
      if (schemeMeta) schemeMeta.content = theme;
    } else {
      html.removeAttribute('data-theme');
      if (schemeMeta) schemeMeta.content = 'light dark';
    }

    if (persist) {
      try {
        if (isTheme(theme)) localStorage.setItem(STORAGE_KEY, theme);
        else localStorage.removeItem(STORAGE_KEY);
      } catch (e) {}
    }

    syncIcons();
  }

  function toggle() {
    apply(current() === 'dark' ? 'light' : 'dark', true);
  }

  function init() {
    apply(storedTheme(), false);

    window.addEventListener('storage', function (event) {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      apply(event.newValue, false);
    });

    if (window.matchMedia) {
      var media = window.matchMedia('(prefers-color-scheme: dark)');
      if (media && media.addEventListener) {
        media.addEventListener('change', function () {
          if (storedTheme() === null) syncIcons();
        });
      }
    }
  }

  window.AnneTheme = {
    init: init,
    toggle: toggle,
    current: current,
    syncIcons: syncIcons
  };

  init();
})();
