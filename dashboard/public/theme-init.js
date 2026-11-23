// Aplica o tema antes da primeira pintura para evitar flash branco (anti-FOUC).
// Arquivo externo para respeitar a CSP `script-src 'self'` (sem inline script).
(function () {
  try {
    var saved = localStorage.getItem('anne_theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
  } catch (e) {}
})();
