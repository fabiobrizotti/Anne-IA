'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function makeIcon() {
  const classes = new Set();
  return {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
        return classes.has(name);
      }
    }
  };
}

function loadTheme({ stored = null, systemDark = false } = {}) {
  const attributes = Object.create(null);
  const html = {
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name); }
  };

  const scheme = { content: 'light dark' };
  const icons = {
    'theme-icon-sun': makeIcon(),
    'theme-icon-moon': makeIcon()
  };

  const values = Object.create(null);
  if (stored !== null) values.anne_theme = stored;
  const storage = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setItem(key, value) { values[key] = String(value); },
    removeItem(key) { delete values[key]; }
  };

  let changeCallback = null;
  const mediaQuery = {
    matches: systemDark,
    addEventListener(type, callback) {
      if (type === 'change') changeCallback = callback;
    }
  };

  let storageCallback = null;

  const sandbox = {
    document: {
      documentElement: html,
      querySelector(selector) {
        return selector === 'meta[name="color-scheme"]' ? scheme : null;
      },
      getElementById(id) { return icons[id] || null; }
    },
    localStorage: storage,
    matchMedia(query) {
      return query === '(prefers-color-scheme: dark)' ? mediaQuery : null;
    },
    addEventListener(type, callback) {
      if (type === 'storage') storageCallback = callback;
    }
  };
  sandbox.window = sandbox;

  const code = fs.readFileSync('public/theme-init.js', 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'theme-init.js' });

  return {
    window: sandbox,
    scheme,
    html,
    storage,
    changeScheme(matches) {
      mediaQuery.matches = matches;
      if (changeCallback) changeCallback({ matches });
    },
    onStorage(event) {
      if (storageCallback) storageCallback(event);
    }
  };
}

test('theme module > follows system when no preference is stored', () => {
  const { window, html, scheme } = loadTheme({ stored: null, systemDark: true });
  assert.equal(html.getAttribute('data-theme'), null);
  assert.equal(scheme.content, 'light dark');
  assert.equal(window.AnneTheme.current(), 'dark');
});

test('theme module > applies a stored preference to attribute and meta', () => {
  const { window, html, scheme } = loadTheme({ stored: 'dark', systemDark: false });
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.equal(scheme.content, 'dark');
  assert.equal(window.AnneTheme.current(), 'dark');
});

test('theme module > toggle persists the opposite effective scheme', () => {
  const { window, html, storage } = loadTheme({ stored: null, systemDark: false });
  window.AnneTheme.toggle();
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.equal(storage.getItem('anne_theme'), 'dark');
});

test('theme module > never clears a stored preference on system change', () => {
  const { html, storage, changeScheme } = loadTheme({ stored: 'dark', systemDark: false });
  changeScheme(true);
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.equal(storage.getItem('anne_theme'), 'dark');
});

test('theme module > syncs icons on system change without stored preference', () => {
  const { window, changeScheme } = loadTheme({ stored: null, systemDark: false });
  const sun = window.document.getElementById('theme-icon-sun');
  const moon = window.document.getElementById('theme-icon-moon');
  changeScheme(true);
  assert.equal(window.AnneTheme.current(), 'dark');
  assert.equal(sun.classList.contains('hidden'), false);
  assert.equal(moon.classList.contains('hidden'), true);
  assert.equal(window.document.documentElement.hasAttribute('data-theme'), false);
});

test('theme module > storage event from another tab is applied', () => {
  const { html, scheme, onStorage } = loadTheme({ stored: null, systemDark: false });
  onStorage({ key: 'anne_theme', newValue: 'dark' });
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.equal(scheme.content, 'dark');
});

test('theme module > syncs icons without inline scripts in pages', () => {
  const index = fs.readFileSync('public/index.html', 'utf8');
  const login = fs.readFileSync('public/login.html', 'utf8');
  for (const html of [index, login]) {
    assert.match(html, /<script src="theme-init\.js"><\/script>/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
  }
});

test('style tokens > base color scheme follows the system', () => {
  const css = fs.readFileSync('public/style.css', 'utf8');
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark/s);
  assert.match(css, /html\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/s);
  assert.match(css, /html\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/s);
});

test('style tokens > dark tokens are declared in a single media fallback', () => {
  const css = fs.readFileSync('public/style.css', 'utf8');
  assert.equal((css.match(/@media \(prefers-color-scheme: dark\)/g) || []).length, 1);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*html:not\(\[data-theme\]\)/);
});

test('style tokens > no hardcoded colors outside token definitions', () => {
  const css = fs.readFileSync('public/style.css', 'utf8');
  let inQr = false;
  const offenders = css.split('\n').filter((line) => {
    if (line.includes('.qrcode-placeholder')) inQr = true;
    else if (inQr && line.includes('}')) inQr = false;
    const hasColor = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/.test(line);
    return hasColor && !/^\s*--/.test(line) && !inQr;
  });
  assert.deepEqual(offenders, []);
});

test('style tokens > institutional identity and semantic tokens exist', () => {
  const css = fs.readFileSync('public/style.css', 'utf8');
  for (const token of ['--brand-bar-bg', '--brand-bar-text', '--brand-bar-muted', '--overlay', '--shadow', '--success', '--success-bg', '--warning', '--info', '--danger', '--danger-bg']) {
    assert.match(css, new RegExp(`${token}:`));
  }
  assert.match(css, /:root\s*\{[^}]*accent-color:\s*var\(--primary\)/s);
  assert.match(css, /\.qrcode-placeholder\s*\{[^}]*color-scheme:\s*only light/s);
  assert.match(css, /--radius:\s*2px/);
  assert.match(css, /\.table td\s*\{[^}]*padding:\s*8px 12px/s);
});

test('style tokens > no color fallback hardcoded in dashboard markup', () => {
  for (const page of ['public/index.html', 'public/login.html']) {
    const html = fs.readFileSync(page, 'utf8');
    assert.doesNotMatch(html, /var\(--[\w-]+\s*,\s*#[0-9a-fA-F]{3,8}\)/);
  }
});

test('style tokens > tier badges use explicit T1/T2/T3 labels', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  for (const tier of [1, 2, 3]) {
    const pattern = new RegExp(`badge-tier-${tier}"><span class="visually-hidden">Nível ${tier}</span>T${tier}</span>`);
    assert.ok(pattern.test(app), `app.js deve renderizar a etiqueta T${tier}`);
  }
});

test('style tokens > segmented control uses a dedicated contained shadow', () => {
  const css = fs.readFileSync('public/style.css', 'utf8');
  assert.match(css, /\.auth-tab-btn\.active\s*\{[^}]*box-shadow:\s*var\(--shadow-control\)/s);
  const blocks = [
    ':root',
    'html\\[data-theme="dark"\\]',
    '@media \\(prefers-color-scheme: dark\\)\\s*\\{\\s*html:not\\(\\[data-theme\\]\\)'
  ];
  for (const selector of blocks) {
    const match = css.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`, 's'));
    assert.ok(match, `bloco ${selector} ausente`);
    assert.match(match[0], /--shadow-control:\s*0 1px 3px rgba\(0, 0, 0, 0\.(06|24)\)/);
  }
});

test('sidebar markup > preserves page-tab contract', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.match(html, /class="app-shell"/);
  assert.match(html, /class="sidebar"/);
  assert.match(html, /class="app-main"/);
  assert.match(html, /class="brand-bar"/);
  assert.match(html, /class="sidebar-footer"/);
  assert.doesNotMatch(html, /class="page-nav"/);
  const tabs = [...html.matchAll(/data-page-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, [
    'tab-instancias', 'tab-financeiro', 'tab-ia', 'tab-logs', 'tab-usuarios',
  ]);
  assert.match(html, /id="tab-usuarios-btn"[^>]*style="display: none;"/);
  for (const id of ['tab-instancias', 'tab-financeiro', 'tab-ia', 'tab-logs']) {
    assert.match(html, new RegExp(`id="${id}" class="page-content`));
  }
  for (const id of ['last-sync-time', 'user-badge', 'current-user-name', 'current-user-role', 'btn-theme-toggle', 'btn-refresh', 'btn-new-instance', 'btn-logout']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('sidebar markup > log stream cleanup binds to sidebar navigation', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.match(app, /document\.querySelector\('\.sidebar-nav'\);\s*if \(tabsContainer\)/);
  assert.doesNotMatch(app, /\.page-nav/);
});

test('sidebar styles > mobile shell stretches page panels', () => {
  const css = fs.readFileSync('public/style.css', 'utf8');
  const media = css.match(/@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(media, 'media query de 900px ausente');
  assert.match(media[1], /\.app-shell\s*\{[^}]*align-items:\s*stretch/s);
});

test('login > keeps central card and institutional identity', () => {
  const html = fs.readFileSync('public/login.html', 'utf8');
  assert.match(html, /class="login-body"/);
  assert.match(html, /class="login-container"/);
  assert.match(html, /class="login-header brand-bar"/);
  assert.doesNotMatch(html, /class="sidebar"/);
  assert.match(html, /id="btn-theme-toggle"/);
});

test('login > delegates theme to shared module', () => {
  const js = fs.readFileSync('public/login.js', 'utf8');
  assert.match(js, /AnneTheme\.syncIcons\(\)/);
  assert.match(js, /AnneTheme\.toggle\(\)/);
  assert.doesNotMatch(js, /localStorage\.setItem\(\s*['"]anne_theme/);
});

test('login > theme toggle hover stays within the brand bar palette', () => {
  const css = fs.readFileSync('public/style.css', 'utf8');
  const match = css.match(/\.login-header \.btn-secondary:hover\s*\{[^}]*\}/s);
  assert.ok(match, 'bloco .login-header .btn-secondary:hover ausente');
  assert.match(match[0], /background-color:\s*var\(--brand-bar-muted\)/);
  assert.match(match[0], /color:\s*var\(--brand-bar-bg\)/);
  assert.doesNotMatch(match[0], /var\(--bg-hover\)/);
  assert.doesNotMatch(match[0], /var\(--text-main\)/);
});
