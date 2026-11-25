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
