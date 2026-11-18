// The viewer: a network's descriptor as a block diagram you can zoom into.
//
// model.js lays the network out once, every block's insides shrunk to fit in
// the block; this draws it. Zooming scales the drawing, text and all, and
// fades a block's summary into what it is made of once that is big enough to
// see. The SVG is rebuilt on every change of the view, in screen pixels, and
// only what is on screen (and big enough to see) is built.

import {
  buildTree, layout, openness, legibility, maxZoom, endpointNode, formatShape,
  shapeSymbols, concreteShape, formatBytes, formatCount, wrap, shorten,
  HEADER, TITLE_PX, LABEL_PX, SUB_PX, SHAPE_PX,
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
const pullButton = document.getElementById('pull');
const noticeEl = document.getElementById('notice');

const elk = new window.ELK();

const state = {
  index: null,
  current: null,   // {scope, name, version}
  descriptor: null,
  tree: null,
  view: { k: 1, tx: 0, ty: 0 },
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
  setUpPull();
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

// ------------------------------------------------------------------ pull ---

// The button is there only if the service may pull its checkout of MaUR-O.
async function setUpPull() {
  try {
    const source = await getJson('source');
    if (!source.pull) return;
    describeSource(source);
    pullButton.hidden = false;
  } catch {
    // No button, then: the rest of the page works the same.
  }
}

function describeSource(source) {
  const date = source.date ? `, ${source.date.slice(0, 10)}` : '';
  pullButton.title = `Get the latest networks: git pull of MaUR-O's ${source.branch} branch (now at ${source.commit}${date})`;
}

let noticeTimer = 0;
function notice(text, failed = false) {
  noticeEl.textContent = text;
  noticeEl.classList.toggle('failed', failed);
  noticeEl.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, failed ? 15000 : 7000);
}

/** "unet 0.3" for every version in `after` which `before` did not have. */
function newVersions(before, after) {
  const had = new Set((before ? before.networks : []).flatMap((n) =>
    n.versions.map((v) => `${n.scope}/${n.name}/${v.version}`)));
  return after.networks.flatMap((n) => n.versions
    .filter((v) => !had.has(`${n.scope}/${n.name}/${v.version}`))
    .map((v) => ({ scope: n.scope, name: n.name, version: v.version })));
}

pullButton.addEventListener('click', async () => {
  const label = pullButton.textContent;
  pullButton.disabled = true;
  pullButton.textContent = 'Pulling…';
  try {
    const response = await fetch(api('pull'), { method: 'POST', cache: 'no-store' });
    const body = await response.text();
    if (!response.ok) throw new Error(body || `${response.status}`);
    const { before, after, changed } = JSON.parse(body);
    describeSource(after);
    const old = state.index;
    state.index = await getJson('networks');
    const fresh = newVersions(old, state.index);
    renderNav();
    if (state.current) renderVersions();
    if (!changed) {
      notice(`Already up to date: ${after.branch} at ${after.commit}.`);
    } else {
      const what = fresh.length
        ? `new: ${fresh.map((v) => `${v.name} ${v.version}`).join(', ')}`
        : 'no new network versions';
      notice(`Pulled ${after.branch}: ${before.commit} → ${after.commit}, ${what}.`);
    }
    // Looking at the latest version of a network which has a newer one now:
    // show that. Any other version stays as it is.
    const cur = state.current;
    const network = cur && state.index.networks.find((n) => n.scope === cur.scope && n.name === cur.name);
    const wasLatest = cur && old && old.networks.some((n) => n.scope === cur.scope && n.name === cur.name && n.latest === cur.version);
    if (network && wasLatest && network.latest !== cur.version) open(cur.scope, cur.name, network.latest);
    else if (!cur && state.index.networks[0]) {
      const first = state.index.networks[0];
      open(first.scope, first.name, first.latest);
    }
  } catch (e) {
    notice(`Pull failed: ${e.message}`, true);
  } finally {
    pullButton.disabled = false;
    pullButton.textContent = label;
  }
});

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
    await layout(elk, tree.root, measure);
    if (ticket !== loading) return;
    Object.assign(state, { current: { scope, name, version }, descriptor, tree, selected: null });
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

// The zoom which shows the whole network.
function fitK() {
  const { width, height } = size();
  const root = state.tree.root;
  return Math.min((width - 140) / root.w, (height - 60) / root.h);
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
function zoomTo(cx, cy, k, animate = true) {
  const { width, height } = size();
  const target = { cx, cy, k };
  cancelAnimationFrame(animation);
  const apply = ({ cx, cy, k }) => {
    state.view = { k, tx: width / 2 - cx * k, ty: height / 2 - cy * k };
    schedule();
  };
  if (!animate) { apply(target); return; }
  const from = viewCenter();
  const t0 = performance.now();
  const step = (now) => {
    const t = clamp((now - t0) / 380, 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    apply({
      cx: from.cx + (target.cx - from.cx) * e,
      cy: from.cy + (target.cy - from.cy) * e,
      k: from.k * Math.pow(target.k / from.k, e),
    });
    if (t < 1) animation = requestAnimationFrame(step);
  };
  animation = requestAnimationFrame(step);
}

function zoomBox(x0, y0, x1, y1) {
  const { width, height } = size();
  const k = Math.min((width * 0.8) / (x1 - x0), (height * 0.8) / (y1 - y0), maxZoom(state.tree));
  zoomTo((x0 + x1) / 2, (y0 + y1) / 2, k);
}

const zoomNode = (node) => zoomBox(node.x, node.y, node.x + node.w, node.y + node.h);

// An arrow, with what it joins: the blocks at its ends are in the picture.
function zoomEdge(edge) {
  if (!edge.route) return zoomNode(edge.container);
  const xs = edge.route.map((p) => p.x), ys = edge.route.map((p) => p.y);
  const pad = 80 * edge.unit;
  zoomBox(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad);
}

function zoomAt(px, py, factor) {
  cancelAnimationFrame(animation);
  const v = state.view;
  const k = clamp(v.k * factor, fitK() * 0.5, Math.max(fitK(), maxZoom(state.tree)));
  const r = k / v.k;
  state.view = { k, tx: px - (px - v.tx) * r, ty: py - (py - v.ty) * r };
  schedule();
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

// Below this many pixels a text is not even built: it could not be read.
const MIN_TEXT_PX = 4;

function render() {
  if (!state.tree) { svg.replaceChildren(); return; }
  const { width, height } = size();
  const { k, tx, ty } = state.view;
  const sx = (x) => x * k + tx;
  const sy = (y) => y * k + ty;
  const root = make('g');
  const visible = (n) => {
    const x = sx(n.x), y = sy(n.y);
    return x < width && y < height && x + n.w * k > 0 && y + n.h * k > 0;
  };
  const isSelected = (kind, key) => state.selected && state.selected.kind === kind && state.selected.key === key;

  // One line of text, `px` high on screen, faded as it gets too small to read.
  function text(parent, str, x, y, px, cls, anchor = 'middle', alpha = 1) {
    const o = alpha * legibility(px);
    if (px < MIN_TEXT_PX || o <= 0.02) return;
    make('text', {
      x: x.toFixed(1), y: y.toFixed(1), 'text-anchor': anchor, 'font-size': px.toFixed(2), class: cls,
      opacity: o.toFixed(2), 'pointer-events': 'none',
    }, parent, str);
  }

  // Lines centred in a box, as many as fit: [{text, px, cls}].
  function textBlock(parent, lines, x, y, w, h, alpha = 1) {
    if (lines[0].px < MIN_TEXT_PX) return;
    const avail = w - lines[0].px;
    const shown = [];
    let used = 0;
    for (const l of lines) {
      const lh = l.px * 1.3;
      if (used + lh > h * 0.92) break;
      shown.push(l);
      used += lh;
    }
    let cy = y + (h - used) / 2;
    for (const l of shown) {
      const fit = Math.floor(avail / (l.px * (l.cls.includes('mono') ? 0.6 : 0.56)));
      text(parent, l.text.length > fit ? shorten(l.text, Math.max(3, fit)) : l.text,
        x + w / 2, cy + l.px * 1.0, l.px, l.cls, 'middle', alpha);
      cy += l.px * 1.3;
    }
  }

  function summaryLines(node, u, first) {
    const lines = first ? [first] : [];
    const small = SUB_PX * u;
    if (node.id !== node.label) lines.push({ text: node.id, px: small, cls: 'sub mono' });
    if (node.summary) {
      const chars = Math.max(8, Math.floor((node.w * k - small) / (small * 0.55)));
      for (const t of wrap(node.summary, chars, 3)) lines.push({ text: t, px: small, cls: 'sub' });
    }
    return lines;
  }

  function drawNode(node, parent) {
    if (!visible(node)) return;
    const x = sx(node.x), y = sy(node.y), w = node.w * k, h = node.h * k;
    // Pixels per unit in the frame this block is drawn in: every size of it is that times something.
    const u = node.unit * k;
    if (w < 1.5 || h < 1.5) return;
    const selected = isSelected('node', node.path);
    const g = make('g', { 'data-id': node.path }, parent);
    make('title', {}, g, `${node.label} (${node.path})${node.summary ? '\n' + node.summary : ''}`);
    const rx = Math.min(8 * u, 10);

    if (node.children.length === 0) {
      make('rect', { x, y, width: w, height: h, rx, class: `block k-${node.kind}${selected ? ' selected' : ''}` }, g);
      textBlock(g, summaryLines(node, u, { text: node.label, px: LABEL_PX * u, cls: 'label' }), x, y, w, h);
      return;
    }

    const t = openness(node, k, { width, height });
    make('rect', {
      x, y, width: w, height: h, rx, class: `block ${node.parent ? `k-${node.kind}` : 'root'}${selected ? ' selected' : ''}`,
    }, g);
    const head = HEADER * u;
    const titlePx = TITLE_PX * u;
    const titleFits = Math.floor((w - 20 * u) / (titlePx * 0.58));
    text(g, shorten(node.label, Math.max(4, titleFits)), x + 10 * u, y + head * 0.5 + titlePx * 0.36, titlePx, 'label', 'start');

    const bodyY = y + head, bodyH = h - head;
    // The summary goes, then what is inside comes: the two are never on top of each other.
    const summary = 1 - clamp(t / 0.45, 0, 1), insides = clamp((t - 0.4) / 0.6, 0, 1);
    const lines = summaryLines(node, u, null);
    if (summary > 0 && lines.length) textBlock(g, lines, x, bodyY, w, bodyH - 4 * u, summary);
    if (insides > 0) {
      const inside = make('g', { opacity: insides.toFixed(2) }, g);
      // Until it has mostly opened, a click on what is inside is a click on the block.
      if (insides < 0.5) inside.setAttribute('pointer-events', 'none');
      const pad = 4 * u;
      make('rect', {
        x: x + pad, y: bodyY, width: w - 2 * pad, height: bodyH - pad, rx: rx * 0.6, class: 'body',
        'pointer-events': 'none',
      }, inside);
      if (node.parent) drawConnectors(node, inside);
      drawEdges(node, inside);
      for (const child of node.children) drawNode(child, inside);
    }
    if (!node.parent) drawRootPorts(node, g);
  }

  // From where an arrow reaches a block from outside to where it goes on
  // inside: the layout puts the two level, so it is a short straight line.
  function drawConnectors(node, parent) {
    const width = edgeWidth(node.inner * k);
    for (const [name, inner] of Object.entries(node.innerPorts)) {
      const outer = node.ports[name];
      if (!outer) continue;
      make('line', {
        x1: sx(outer.x).toFixed(1), y1: sy(outer.y).toFixed(1), x2: sx(inner.x).toFixed(1), y2: sy(inner.y).toFixed(1),
        class: 'edge', style: `stroke-width:${width.toFixed(2)}px`, 'pointer-events': 'none',
      }, parent);
    }
  }

  const edgeWidth = (u) => clamp(1.4 * u, 0.4, 1.8);

  function drawEdges(node, parent) {
    for (const edge of node.edges) {
      if (!edge.route) continue;
      const pts = edge.route.map((p) => ({ x: sx(p.x), y: sy(p.y) }));
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      if (Math.max(...xs) < 0 || Math.min(...xs) > width || Math.max(...ys) < 0 || Math.min(...ys) > height) continue;
      const u = edge.unit * k;
      const selected = isSelected('edge', edge.key);
      const g = make('g', { 'data-edge': edge.key, class: 'edgeg' }, parent);
      make('title', {}, g, `${formatShape(edge.shape)}  (${edge.from} → ${edge.to})`);
      // Stop short of the head so the line does not poke through it.
      const head = clamp(7 * u, 2, 11);
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      const len = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
      const ux = (last.x - prev.x) / len, uy = (last.y - prev.y) / len;
      const lined = pts.slice(0, -1).concat([{ x: last.x - ux * head * 0.8, y: last.y - uy * head * 0.8 }]);
      const d = lined.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const lw = edgeWidth(u) * (selected ? 1.8 : 1);
      make('path', { d, class: 'hit', style: `stroke-width:${clamp(14 * u, 4, 14).toFixed(1)}px` }, g);
      make('path', { d, class: `edge${selected ? ' selected' : ''}`, style: `stroke-width:${lw.toFixed(2)}px` }, g);
      const nx = -uy, ny = ux;
      make('polygon', {
        points: [
          [last.x, last.y],
          [last.x - ux * head + nx * head * 0.45, last.y - uy * head + ny * head * 0.45],
          [last.x - ux * head - nx * head * 0.45, last.y - uy * head - ny * head * 0.45],
        ].map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '),
        class: `edge-head${selected ? ' selected' : ''}`,
      }, g);
      // The shape, where the layout made room for it.
      const px = SHAPE_PX * u;
      if (!edge.labelAt || px < MIN_TEXT_PX) continue;
      text(g, formatShape(edge.shape), sx(edge.labelAt.x), sy(edge.labelAt.y) + px * 0.35, px, 'shape');
    }
  }

  // The network's own input and output, named.
  function drawRootPorts(node, parent) {
    const u = k;
    for (const [name, p] of Object.entries(node.ports)) {
      const x = sx(p.x), y = sy(p.y);
      make('circle', { cx: x, cy: y, r: clamp(4 * u, 2, 6), class: 'port', 'pointer-events': 'none' }, parent);
      const inbound = name.startsWith('@in');
      const label = name === '@in' ? 'input' : name === '@out' ? 'output' : name.slice(name.indexOf(':') + 1);
      const px = 13 * u;
      text(parent, label, x + (inbound ? -1 : 1) * 9 * u, y + px * 0.35, px, 'io', inbound ? 'end' : 'start');
    }
  }

  drawNode(state.tree.root, root);
  svg.replaceChildren(root);
}

// ------------------------------------------------------------ interaction ---

const pointers = new Map();
let drag = null;
let pinch = null;

svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = size();
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
      zoomNode(node);
    });
  }
  for (const b of detailEl.querySelectorAll('button[data-edge]')) {
    b.addEventListener('click', () => {
      select({ kind: 'edge', key: b.getAttribute('data-edge') });
      zoomEdge(state.tree.edges.get(b.getAttribute('data-edge')));
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
