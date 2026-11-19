const test = require('node:test');
const assert = require('node:assert');
const dock = require('../src/ui/dock');

// minimal page: <html> with classList and append, getElementById, and window.dispatchEvent
function fakePage() {
  const els = {};
  const cls = new Set();
  const html = {
    children: [],
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
    append(el) {
      this.children.push(el);
      els[el.id] = el;
    },
  };
  global.document = {
    documentElement: html,
    createElement: () => {
      const el = { id: '', textContent: '' };
      el.remove = () => {
        delete els[el.id];
        html.children = html.children.filter((x) => x !== el);
      };
      return el;
    },
    getElementById: (id) => els[id] || null,
  };
  const events = [];
  global.window = { dispatchEvent: (e) => events.push(e.type) };
  global.Event = class {
    constructor(t) {
      this.type = t;
    }
  };
  return { els, cls, head: html, events };
}

test('dock css narrows the page body by the column width', () => {
  const c = dock.css(420);
  assert.match(c, /width: calc\(100vw - 420px\)/);
  assert.match(c, /html\.vt-dock body/);
});

test('dock apply adds one style, changes width in place, removes everything on 0', () => {
  const p = fakePage();
  assert.equal(dock.apply(400), true);
  assert.equal(p.head.children.length, 1);
  assert.ok(p.cls.has('vt-dock'));
  assert.match(p.els['vt-dock-style'].textContent, /100vw - 400px/);
  assert.equal(dock.apply(400), false); // same width: nothing to do
  assert.equal(dock.apply(500.4), true);
  assert.equal(p.head.children.length, 1); // same style element, new width
  assert.match(p.els['vt-dock-style'].textContent, /100vw - 500px/);
  assert.equal(dock.apply(0), true);
  assert.equal(p.head.children.length, 0);
  assert.ok(!p.cls.has('vt-dock'));
  assert.equal(dock.width(), 0);
});
