// The viewer: a network's descriptor as a block diagram you can zoom into.
//
// model.js decides what there is (the tree, the layout, which blocks are
// opened at a zoom); this draws it. The SVG is rebuilt on every change of the
// view, with every coordinate already in screen pixels, so lines and text
// stay the size they are meant to be at any zoom, and only what is on screen
// is built.

import {
  buildTree, layout, decideToggle, toggled, revealed, endpointNode, formatShape,
  shapeSymbols, concreteShape, formatBytes, formatCount, wrap, shorten, PAD_TOP,
} from './model.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const detailEl = document.getElementById('detail');
const navEl = document.getElementById('networks');
const versionEl = document.getElementById('version');
const versionLabel = document.getElementById('version-label');
const fitButton = document.getElementById('fit');

const elk = new window.ELK();

const state = {
  index: null,
  current: null,   // {scope, name, version}
  descriptor: null,
  tree: null,
  view: { k: 1, tx: 0, ty: 0 },
  openSet: new Set(), // the blocks which are opened into their children
  selected: null,  // {kind: 'node'|'edge', key}
  symbols: { B: 1, H: 256, W: 256 },
};

// A page-relative URL: the service may live under a path of a reverse proxy.
const api = (path) => new URL(`api/${path}`, document.baseURI).toString();

const measureCtx = document.createElement('canvas').getContext('2d');
function measure(text, px, weight = 400) {
  measureCtx.font = `${weight} ${px}px system-ui, sans-serif`;
  return measureCtx.measureText(text).width;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --------------------------------------------------------------- loading ---

async function getJson(path) {
  const response = await fetch(api(path), { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function setStatus(text) { statusEl.textContent = text; }

async function start() {
  try {
    state.index = await getJson('networks');
  } catch (e) {
    setStatus(`Cannot read the network list: ${e.message}`);
    return;
  }
  renderNav();
  window.addEventListener('hashchange', openFromHash);
  if (!(await openFromHash())) {
    const first = state.index.networks[0];
    if (first) open(first.scope, first.name, first.latest);
    else setStatus('No networks yet. Run `mauro net describe` in MaUR-O and pull.');
  }
}

async function openFromHash() {
  const [scope, name, version] = decodeURIComponent(location.hash.slice(1)).split('/');
  const network = state.index.networks.find((n) => n.scope === scope && n.name === name);
  if (!network) return false;
  const known = network.versions.some((v) => v.version === version);
  await load(scope, name, known ? version : network.latest);
  return true;
}

function open(scope, name, version) {
  const hash = `#${scope}/${name}/${version}`;
  if (location.hash === hash) load(scope, name, version);
  else location.hash = hash; // hashchange loads it
}

let loading = 0;
async function load(scope, name, version) {
  const ticket = ++loading;
  setStatus('Loading…');
  try {
    const descriptor = await getJson(`networks/${scope}/${name}/${version}`);
    if (ticket !== loading) return;
    const tree = buildTree(descriptor);
    setStatus('Laying out…');
    const openSet = new Set();
    await layout(elk, tree.root, measure, openSet);
    if (ticket !== loading) return;
    Object.assign(state, { current: { scope, name, version }, descriptor, tree, selected: null, openSet });
    setStatus('');
    renderNav();
    renderVersions();
    fit(false);
    showDetail();
    hintEl.hidden = false;
    fitButton.hidden = false;
  } catch (e) {
    if (ticket === loading) setStatus(`Cannot show ${scope}/${name} ${version}: ${e.message}`);
  }
}

function renderNav() {
  navEl.replaceChildren();
  const scopes = [...new Set(state.index.networks.map((n) => n.scope))];
  for (const scope of scopes) {
    const h = document.createElement('h2');
    h.textContent = scope.replaceAll('_', ' ');
    navEl.append(h);
    for (const network of state.index.networks.filter((n) => n.scope === scope)) {
      const b = document.createElement('button');
      const current = state.current && state.current.scope === scope && state.current.name === network.name;
      b.setAttribute('aria-current', current ? 'true' : 'false');
      b.innerHTML = `${esc(network.name)}<small>${esc(network.latest)}</small>`;
      b.addEventListener('click', () => open(scope, network.name, network.latest));
      navEl.append(b);
    }
  }
}

function renderVersions() {
  const { scope, name, version } = state.current;
  const network = state.index.networks.find((n) => n.scope === scope && n.name === name);
  versionEl.replaceChildren();
  for (const v of [...network.versions].reverse()) {
    const o = document.createElement('option');
    o.value = v.version;
    const date = v.generated_at ? v.generated_at.slice(0, 10) : '';
    o.textContent = [v.version, date, v.git_commit].filter(Boolean).join(' · ');
    o.selected = v.version === version;
    versionEl.append(o);
  }
  versionLabel.hidden = false;
}

versionEl.addEventListener('change', () => {
  const { scope, name } = state.current;
  open(scope, name, versionEl.value);
});

// ----------------------------------------------------------------- view ---

const size = () => svg.getBoundingClientRect();

// The zoom which shows the whole of the root, for the layout as it is now.
function fitK() {
  const { width, height } = size();
  const root = state.tree.root;
  return Math.min((width - 220) / root.w, (height - 80) / root.h);
}

function fit(animate = true) {
  const root = state.tree.root;
  zoomTo(root.x + root.w / 2, root.y + root.h / 2, fitK(), animate);
}

function viewCenter() {
  const { width, height } = size();
  const { k, tx, ty } = state.view;
  return { cx: (width / 2 - tx) / k, cy: (height / 2 - ty) / k, k };
}

let animation = 0;
let animating = false;
// Where the pointer last was, in the canvas's pixels: what a zoom is about.
let pointer = null;
function zoomTo(cx, cy, k, animate = true) {
  const { width, height } = size();
  const target = { cx, cy, k };
  cancelAnimationFrame(animation);
  const apply = ({ cx, cy, k }) => {
    state.view = { k, tx: width / 2 - cx * k, ty: height / 2 - cy * k };
    schedule();
  };
  if (!animate) { animating = false; apply(target); return; }
  const from = viewCenter();
  const t0 = performance.now();
  animating = true;
  const step = (now) => {
    const t = clamp((now - t0) / 380, 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    apply({
      cx: from.cx + (target.cx - from.cx) * e,
      cy: from.cy + (target.cy - from.cy) * e,
      k: from.k * Math.pow(target.k / from.k, e),
    });
    if (t < 1) animation = requestAnimationFrame(step);
    else animating = false;
  };
  animation = requestAnimationFrame(step);
}

function zoomNode(node) {
  const { width, height } = size();
  const k = Math.min((width * 0.8) / node.w, (height * 0.8) / node.h);
  zoomTo(node.x + node.w / 2, node.y + node.h / 2, k);
}

function zoomAt(px, py, factor) {
  cancelAnimationFrame(animation);
  animating = false;
  const v = state.view;
  const k = clamp(v.k * factor, fitK() * 0.5, 14);
  const r = k / v.k;
  state.view = { k, tx: px - (px - v.tx) * r, ty: py - (py - v.ty) * r };
  schedule();
}

// ----------------------------------------------------- opening and closing ---

// The layout changes when a block opens or closes, and with it every
// coordinate. The view is remapped so that what is under the pointer stays
// under it: the block there keeps its place, and everything else moves aside.
// If that block is the very one which opens (or closes) it is the same share
// of the way across it, and it is as wide on the screen as it was.

/** The deepest shown block under the screen point `p`, and where in it (0..1 each way). */
function blockAt(p) {
  const { k, tx, ty } = state.view;
  const inside = (n) => {
    const x = n.x * k + tx, y = n.y * k + ty;
    return p.x >= x && p.x <= x + n.w * k && p.y >= y && p.y <= y + n.h * k;
  };
  let node = state.tree.root;
  for (;;) {
    const next = node.open ? node.children.find(inside) : null;
    if (!next) break;
    node = next;
  }
  const x = node.x * k + tx, y = node.y * k + ty;
  return {
    node,
    u: clamp((p.x - x) / (node.w * k), 0, 1),
    v: clamp((p.y - y) / (node.h * k), 0, 1),
    screenW: node.w * k,
  };
}

let relaying = false;
async function setOpen(path, open) {
  relaying = true;
  try {
    const target = state.tree.byPath.get(path);
    const { width, height } = size();
    const p = pointer || { x: width / 2, y: height / 2 };
    const old = state.view;
    const anchor = blockAt(p).node;
    const rect = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h });
    // Where the pointer is within a block, as a share of the way across and down.
    const share = (r) => ({
      u: clamp((p.x - (r.x * old.k + old.tx)) / (r.w * old.k), 0, 1),
      v: clamp((p.y - (r.y * old.k + old.ty)) / (r.h * old.k), 0, 1),
    });
    const anchorBefore = rect(anchor), targetBefore = rect(target);
    const anchorShare = share(anchorBefore), targetShare = share(targetBefore);

    const openSet = toggled(state.openSet, path, open);
    await layout(elk, state.tree.root, measure, openSet);
    state.openSet = openSet;

    // Three cases: the pointer was over the block which opens or closes, and
    // that block keeps the width it had on the screen; or it was over another
    // block, which keeps its place and its size; or over one inside a block
    // which has just closed, so the closed block takes its place.
    let node, at, k;
    if (anchor !== target && anchor.shown) {
      node = anchor; at = anchorShare; k = old.k;
    } else {
      node = target; at = targetShare; k = (targetBefore.w * old.k) / target.w;
    }
    state.view = {
      k,
      tx: p.x - (node.x + at.u * node.w) * k,
      ty: p.y - (node.y + at.v * node.h) * k,
    };
  } finally {
    relaying = false;
  }
  schedule();
}

// Brings a node which is inside closed blocks into being, and the view to it.
async function reveal(node, zoom = true, openIt = false) {
  relaying = true;
  try {
    const openSet = revealed(state.openSet, node);
    if (openIt && node.parent && node.children.length) openSet.add(node.path);
    await layout(elk, state.tree.root, measure, openSet);
    state.openSet = openSet;
  } finally {
    relaying = false;
  }
  if (zoom) {
    const { width, height } = size();
    const k = Math.min((width * 0.8) / node.w, (height * 0.8) / node.h);
    zoomTo(node.x + node.w / 2, node.y + node.h / 2, k, false);
  }
  schedule();
}

function maybeToggle() {
  if (relaying || animating || !state.tree) return;
  const { width, height } = size();
  const todo = decideToggle(state.tree.root, state.view, { width, height });
  if (todo) setOpen(todo.path, todo.open);
}

// ---------------------------------------------------------------- drawing ---

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

function make(tag, attrs = {}, parent = null, text = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== null) e.textContent = text;
  if (parent) parent.append(e);
  return e;
}

function render() {
  if (!state.tree) { svg.replaceChildren(); return; }
  const { width, height } = size();
  const { k, tx, ty } = state.view;
  const sx = (x) => x * k + tx;
  const sy = (y) => y * k + ty;
  const root = make('g');
  // Where shape labels already are, so that two do not print over each other.
  const taken = [];
  const visible = (n) => {
    const x = sx(n.x), y = sy(n.y);
    return x < width && y < height && x + n.w * k > 0 && y + n.h * k > 0;
  };

  function drawText(parent, node, x, y, w, h) {
    // Label, id, then the summary as far as it fits.
    const main = clamp(14 * k, 0, 22);
    if (main < 8 || w < 28) return;
    const small = Math.max(main * 0.78, 8);
    const avail = w - 12;
    const lines = [];
    let fontMain = main;
    const labelW = measure(node.label, main, 600);
    if (labelW > avail) fontMain = Math.max(8, main * avail / labelW);
    lines.push({ text: node.label, px: fontMain, cls: 'label' });
    if (node.id !== node.label && small >= 8) {
      lines.push({ text: node.id, px: Math.min(small, fontMain), cls: 'sub mono' });
    }
    if (node.summary && small >= 8) {
      const chars = Math.max(6, Math.floor(avail / (small * 0.55)));
      for (const t of wrap(node.summary, chars, 3)) lines.push({ text: t, px: small, cls: 'sub' });
    }
    const lineH = (l) => l.px * 1.3;
    let used = 6;
    const shown = [];
    for (const l of lines) {
      if (used + lineH(l) > h - 2) break;
      shown.push(l);
      used += lineH(l);
    }
    if (!shown.length) return;
    let cy = y + (h - (used - 6)) / 2;
    for (const l of shown) {
      cy += l.px * 1.05;
      let text = l.text;
      const fit = Math.floor(avail / (l.px * (l.cls.includes('mono') ? 0.6 : 0.56)));
      if (text.length > fit) text = shorten(text, Math.max(3, fit));
      make('text', {
        x: x + w / 2, y: cy, 'text-anchor': 'middle', 'font-size': l.px.toFixed(1), class: l.cls,
        'pointer-events': 'none',
      }, parent, text);
      cy += l.px * 0.25;
    }
  }

  function drawNode(node, parent) {
    if (!visible(node)) return;
    const x = sx(node.x), y = sy(node.y), w = node.w * k, h = node.h * k;
    const open = node.open;
    const selected = state.selected && state.selected.kind === 'node' && state.selected.key === node.path;
    const g = make('g', { 'data-id': node.path }, parent);
    make('title', {}, g, `${node.label} (${node.path})${node.summary ? '\n' + node.summary : ''}`);
    if (open) {
      make('rect', {
        x, y, width: w, height: h, rx: Math.min(10, 10 * k + 2), class: `frame${selected ? ' selected' : ''}`,
      }, g);
      const px = clamp(PAD_TOP * k * 0.42, 9, 18);
      if (PAD_TOP * k >= 14 && w > 40) {
        make('text', {
          x: x + 10, y: y + PAD_TOP * k * 0.5 + px * 0.35, 'font-size': px.toFixed(1), class: 'label',
          'pointer-events': 'none',
        }, g, shorten(node.label, Math.max(4, Math.floor((w - 20) / (px * 0.58)))));
      }
      for (const child of node.children) drawNode(child, g);
      drawEdges(node, g);
      drawPorts(node, g);
    } else {
      if (node.children.length > 0) {
        // A block which holds others is drawn as a stack of them.
        const off = clamp(5 * k, 2, 6);
        make('rect', {
          x: x + off * 2, y: y - off * 2, width: w, height: h, rx: Math.min(8, 8 * k + 1), class: 'stack',
        }, g);
        make('rect', {
          x: x + off, y: y - off, width: w, height: h, rx: Math.min(8, 8 * k + 1), class: 'stack',
        }, g);
      }
      make('rect', {
        x, y, width: w, height: h, rx: Math.min(8, 8 * k + 1), class: `block k-${node.kind}${selected ? ' selected' : ''}`,
      }, g);
      drawText(g, node, x, y, w, h);
    }
  }

  function drawEdges(node, parent) {
    for (const edge of node.edges) {
      if (!edge.route) continue;
      const pts = edge.route.map((p) => ({ x: sx(p.x), y: sy(p.y) }));
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      if (Math.max(...xs) < 0 || Math.min(...xs) > width || Math.max(...ys) < 0 || Math.min(...ys) > height) continue;
      const selected = state.selected && state.selected.kind === 'edge' && state.selected.key === edge.key;
      const g = make('g', { 'data-edge': edge.key, class: 'edgeg' }, parent);
      make('title', {}, g, `${formatShape(edge.shape)}  (${edge.from} → ${edge.to})`);
      // Stop short of the head so the line does not poke through it.
      const head = clamp(3 + 5 * Math.sqrt(k), 5, 11);
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      const len = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
      const ux = (last.x - prev.x) / len, uy = (last.y - prev.y) / len;
      const lined = pts.slice(0, -1).concat([{ x: last.x - ux * head * 0.8, y: last.y - uy * head * 0.8 }]);
      const d = lined.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      make('path', { d, class: 'hit' }, g);
      make('path', { d, class: `edge${selected ? ' selected' : ''}` }, g);
      const nx = -uy, ny = ux;
      make('polygon', {
        points: [
          [last.x, last.y],
          [last.x - ux * head + nx * head * 0.45, last.y - uy * head + ny * head * 0.45],
          [last.x - ux * head - nx * head * 0.45, last.y - uy * head - ny * head * 0.45],
        ].map((p) => p.join(',')).join(' '),
        class: `edge-head${selected ? ' selected' : ''}`,
      }, g);
      // The shape, on the longest straight run that has the room for it.
      const text = formatShape(edge.shape);
      const px = clamp(10 + k * 0.5, 10, 13);
      const need = text.length * px * 0.62 + 10;
      let best = null;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const l = Math.hypot(b.x - a.x, b.y - a.y);
        if (!best || l > best.l) best = { a, b, l };
      }
      if (best && best.l >= need) {
        const lx = (best.a.x + best.b.x) / 2, ly = (best.a.y + best.b.y) / 2 - 5;
        const box = { x0: lx - need / 2, x1: lx + need / 2, y0: ly - px, y1: ly + 3 };
        const clash = taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0);
        if (!clash) {
          taken.push(box);
          make('text', {
            x: lx, y: ly, 'text-anchor': 'middle',
            'font-size': px.toFixed(1), class: 'shape', 'pointer-events': 'none',
          }, g, text);
        }
      }
    }
  }

  function drawPorts(node, parent) {
    const names = Object.keys(node.ports);
    for (const name of names) {
      const p = node.ports[name];
      const x = sx(p.x), y = sy(p.y);
      make('circle', { cx: x, cy: y, r: 3.5, class: 'port', 'pointer-events': 'none' }, parent);
      if (node.depth === 0) {
        const inbound = name.startsWith('@in');
        const label = name === '@in' ? 'input' : name === '@out' ? 'output' : name.slice(name.indexOf(':') + 1);
        make('text', {
          x: x + (inbound ? -9 : 9), y: y + 4, 'text-anchor': inbound ? 'end' : 'start', 'font-size': 12,
          class: 'io', 'pointer-events': 'none',
        }, parent, label);
      }
    }
  }

  drawNode(state.tree.root, root);
  svg.replaceChildren(root);
  maybeToggle();
}

// ------------------------------------------------------------ interaction ---

const pointers = new Map();
let drag = null;
let pinch = null;

svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = size();
  pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
}, { passive: false });

svg.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY, tx: state.view.tx, ty: state.view.ty, moved: false };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    drag = null;
  }
});

svg.addEventListener('pointermove', (e) => {
  const r = size();
  pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const r = size();
    zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch.d);
    pinch.d = d;
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 4) {
    drag.moved = true;
    svg.classList.add('dragging');
    svg.setPointerCapture(e.pointerId);
    cancelAnimationFrame(animation);
  }
  if (drag.moved) {
    state.view = { ...state.view, tx: drag.tx + dx, ty: drag.ty + dy };
    schedule();
  }
});

function endPointer(e) {
  const wasDrag = drag && drag.moved;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    svg.classList.remove('dragging');
    if (drag && !wasDrag && e.type === 'pointerup') clicked(e);
    drag = null;
  }
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);

function target(e) {
  const edge = e.target.closest && e.target.closest('[data-edge]');
  if (edge) return { kind: 'edge', key: edge.getAttribute('data-edge') };
  const node = e.target.closest && e.target.closest('[data-id]');
  if (node) return { kind: 'node', key: node.getAttribute('data-id') };
  return null;
}

function clicked(e) {
  select(target(e));
}

svg.addEventListener('dblclick', (e) => {
  const t = target(e);
  if (t && t.kind === 'node') zoomNode(state.tree.byPath.get(t.key));
  else if (!t) fit();
});

window.addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input, select, textarea')) return;
  const r = size();
  if (e.key === 'f') fit();
  else if (e.key === 'Escape') select(null);
  else if (e.key === '+' || e.key === '=') zoomAt(r.width / 2, r.height / 2, 1.4);
  else if (e.key === '-') zoomAt(r.width / 2, r.height / 2, 1 / 1.4);
});

fitButton.addEventListener('click', () => fit());
new ResizeObserver(() => { if (state.tree) schedule(); }).observe(svg);

function select(t) {
  state.selected = t;
  showDetail();
  schedule();
}

// ----------------------------------------------------------------- detail ---

function table(rows) {
  return `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>`;
}

function edgeLink(edge, text) {
  return `<button class="link" data-edge="${esc(edge.key)}">${text}</button>`;
}

function showDetail() {
  const t = state.selected;
  if (!state.tree) { detailEl.innerHTML = ''; return; }
  if (t && t.kind === 'edge') detailEl.innerHTML = edgeDetail(state.tree.edges.get(t.key));
  else detailEl.innerHTML = nodeDetail(t ? state.tree.byPath.get(t.key) : state.tree.root);
  bindDetail();
}

function nodeDetail(node) {
  const { root } = state.tree;
  const d = state.descriptor;
  let html = `<h2>${esc(node.label)}</h2><div class="path">${esc(node.path)}</div>`;
  html += `<p><span class="badge">${esc(node.kind)}</span></p>`;
  if (node.summary) html += `<p>${esc(node.summary)}</p>`;

  const share = root.param_count ? (100 * node.param_count) / root.param_count : 0;
  html += `<h3>Values stored</h3><p><span class="big">${formatCount(node.param_count)}</span>`;
  html += node === root ? '' : ` <span class="badge">${share < 0.01 && node.param_count ? '<0.01' : share.toFixed(2)}% of the network</span>`;
  html += '</p>';

  const params = Object.entries(node.params);
  if (params.length) html += `<h3>Parameters</h3>${table(params.map(([k, v]) => [k, esc(JSON.stringify(v))]))}`;

  if (node.children.length) {
    html += `<h3>Contains</h3><p>${node.children.map((c) =>
      `<button class="link" data-node="${esc(c.path)}">${esc(c.id)}</button>`).join(' · ')}</p>`;
  }

  if (node.parent) {
    const edges = [...node.parent.edges];
    const into = edges.filter((e) => endpointNode(e, 'to') === node);
    const out = edges.filter((e) => endpointNode(e, 'from') === node);
    const list = (es) => table(es.map((e) => [
      edgeLink(e, esc(e.from === node.id ? e.to : e.from)).replace('class="link"', 'class="link" style="font-family:var(--font)"'),
      esc(formatShape(e.shape)),
    ]));
    if (into.length) html += `<h3>Inputs</h3>${list(into.map((e) => e))}`;
    if (out.length) html += `<h3>Outputs</h3>${list(out)}`;
    html += `<p><button class="link" data-node="${esc(node.parent.path)}">↑ ${esc(node.parent.label)}</button></p>`;
  } else {
    html += `<h3>Network</h3>${table([
      ['scope', esc(d.scope)], ['name', esc(d.name)], ['version', esc(d.version)],
      ...Object.entries(d.config).map(([k, v]) => [k, esc(JSON.stringify(v))]),
      ['generated', esc(d.meta.generated_at || '—')], ['commit', esc(d.meta.git_commit || '—')],
    ])}`;
  }
  return html;
}

function edgeDetail(edge) {
  const from = endpointNode(edge, 'from');
  const to = endpointNode(edge, 'to');
  const name = (e, node) => (e.startsWith('@') ? `${node.label} (${e})` : e);
  let html = `<h2>Tensor</h2><div class="path">${esc(edge.container.path)}</div>`;
  html += `<p><span class="big">${esc(formatShape(edge.shape))}</span></p>`;
  html += table([
    ['from', `<button class="link" data-node="${esc(from.path)}">${esc(name(edge.from, from))}</button>`],
    ['to', `<button class="link" data-node="${esc(to.path)}">${esc(name(edge.to, to))}</button>`],
    ['dtype', esc(edge.dtype)],
  ]);
  const symbols = shapeSymbols(edge.shape);
  html += '<h3>For an input of</h3><p>';
  for (const s of ['B', 'H', 'W'].filter((s) => symbols.includes(s)).concat(symbols.filter((s) => !['B', 'H', 'W'].includes(s)))) {
    html += `<label class="sym">${esc(s)} <input type="number" min="1" data-symbol="${esc(s)}" value="${state.symbols[s] ?? 1}"></label>`;
  }
  if (!symbols.length) html += 'Does not depend on the input.';
  html += '</p><div id="computed"></div>';
  return html;
}

function computed(edge) {
  const out = document.getElementById('computed');
  if (!out) return;
  const shape = concreteShape(edge.shape, state.symbols);
  if (!shape) { out.innerHTML = '<p>Not a whole number for these sizes.</p>'; return; }
  const elements = shape.reduce((a, b) => a * b, 1);
  out.innerHTML = table([
    ['shape', esc(`[${shape.join(', ')}]`)],
    ['elements', formatCount(elements)],
    ['as f32', esc(formatBytes(elements * 4))],
  ]);
}

function bindDetail() {
  for (const b of detailEl.querySelectorAll('[data-node]')) {
    b.addEventListener('click', () => {
      const node = state.tree.byPath.get(b.getAttribute('data-node'));
      select({ kind: 'node', key: node.path });
      reveal(node);
    });
  }
  for (const b of detailEl.querySelectorAll('button[data-edge]')) {
    b.addEventListener('click', () => {
      select({ kind: 'edge', key: b.getAttribute('data-edge') });
      const edge = state.tree.edges.get(b.getAttribute('data-edge'));
      reveal(edge.container, true, true);
    });
  }
  const t = state.selected;
  if (t && t.kind === 'edge') {
    const edge = state.tree.edges.get(t.key);
    for (const input of detailEl.querySelectorAll('input[data-symbol]')) {
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (Number.isInteger(v) && v > 0) state.symbols[input.getAttribute('data-symbol')] = v;
        computed(edge);
      });
    }
    computed(edge);
  }
}

// For the browser tests and for poking at the view from the console.
window.maunevi = { state };
start();
