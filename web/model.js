// What a descriptor is, turned into something to lay out and draw.
//
// No DOM here, so that node can test it: the page (app.js) draws, this decides
// what there is to draw and where it goes.
//
// A descriptor (MaUR-O's src/net/describe.rs) is a tree of nodes. Each node
// has `children` and, between those, `edges`. An edge endpoint is a child's
// id (`conv`, or `concat:skip` for one of several inputs) or the node's own
// boundary (`@in`, `@in:skip`, `@out`, `@out:curves`).

export const SEP = '/';

// ---------------------------------------------------------------- shapes ---

/** The value of one dimension (a number, or "H/2", "C+3") given symbol values, or null. */
export function evalDim(dim, symbols) {
  if (typeof dim === 'number') return dim;
  const text = String(dim);
  let at = 0;
  const space = () => { while (text[at] === ' ') at++; };
  const eat = (c) => { space(); if (text[at] === c) { at++; return true; } return false; };
  function sum() {
    let v = product();
    for (;;) {
      if (v === null) return null;
      if (eat('+')) { const r = product(); v = r === null ? null : v + r; }
      else if (eat('-')) { const r = product(); v = r === null ? null : v - r; }
      else return v;
    }
  }
  function product() {
    let v = atom();
    for (;;) {
      if (v === null) return null;
      if (eat('*')) { const r = atom(); v = r === null ? null : v * r; }
      else if (eat('/')) {
        const r = atom();
        if (r === null || r === 0 || v % r !== 0) return null;
        v = v / r;
      } else return v;
    }
  }
  function atom() {
    if (eat('(')) { const v = sum(); return eat(')') ? v : null; }
    space();
    const m = /^[A-Za-z0-9_]+/.exec(text.slice(at));
    if (!m) return null;
    at += m[0].length;
    if (/^\d+$/.test(m[0])) return Number(m[0]);
    return Object.prototype.hasOwnProperty.call(symbols, m[0]) ? symbols[m[0]] : null;
  }
  const v = sum();
  space();
  return at === text.length ? v : null;
}

/** "B×16×H/2×W/2" */
export function formatShape(shape) {
  return shape.map(String).join('×');
}

/** The symbols a shape depends on, in order of first appearance. */
export function shapeSymbols(shape) {
  const found = [];
  for (const dim of shape) {
    if (typeof dim === 'number') continue;
    for (const m of String(dim).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (!found.includes(m[0])) found.push(m[0]);
    }
  }
  return found;
}

/** The shape with symbols replaced, or null if one has no value. */
export function concreteShape(shape, symbols) {
  const out = shape.map((d) => evalDim(d, symbols));
  return out.includes(null) ? null : out;
}

/** "12.3 MB" */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** 1945742 -> "1,945,742" */
export function formatCount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ------------------------------------------------------------------ tree ---

/**
 * Annotates a descriptor's nodes in place with what drawing needs: `path`
 * (ids from the root joined by "/"), `depth`, `parent`; and gives every edge
 * its `container` (the node whose edges it is), `index`, and `key`.
 * Returns {root, byPath, edges}.
 */
export function buildTree(descriptor) {
  const byPath = new Map();
  const edges = new Map();
  (function walk(node, parent, depth) {
    node.parent = parent;
    node.depth = depth;
    node.path = parent ? parent.path + SEP + node.id : node.id;
    node.children = node.children || [];
    node.edges = node.edges || [];
    node.params = node.params || {};
    byPath.set(node.path, node);
    node.edges.forEach((edge, index) => {
      edge.container = node;
      edge.index = index;
      edge.key = `${node.path}#${index}`;
      edges.set(edge.key, edge);
    });
    for (const child of node.children) walk(child, node, depth + 1);
  })(descriptor.root, null, 0);
  return { root: descriptor.root, byPath, edges };
}

/**
 * Where an edge endpoint is: the node that owns the port and the port's name.
 * `role` is 'from' or 'to'. A child with no port named has its default one,
 * `@out` for what leaves it and `@in` for what enters it.
 */
export function endpointPort(endpoint, role, container) {
  if (endpoint.startsWith('@')) {
    return { owner: container, name: endpoint, boundary: true };
  }
  const colon = endpoint.indexOf(':');
  const id = colon < 0 ? endpoint : endpoint.slice(0, colon);
  const port = colon < 0 ? '' : endpoint.slice(colon);
  const owner = container.children.find((c) => c.id === id);
  if (!owner) throw new Error(`${container.path}: no child ${id}`);
  return { owner, name: (role === 'from' ? '@out' : '@in') + port, boundary: false };
}

export const portId = (owner, name) => `${owner.path}#${name}`;

/** The node an endpoint names: a child, or the container itself for its boundary. */
export function endpointNode(edge, role) {
  return endpointPort(role === 'from' ? edge.from : edge.to, role, edge.container).owner;
}

// ---------------------------------------------------------------- layout ---
//
// Every node which holds others is laid out once, on its own: its children
// as blocks, and the edges between them. That picture is then shrunk to fit
// *inside* the node's own block, below its title, so a block is the same
// size whether it shows its summary or what it is made of, and the whole
// network is one fixed drawing. Zooming only scales it (text with it); what
// changes with the zoom is which blocks show their insides (`openness`).
//
// Sizes are in "units": a leaf is about 150 × 58 of them, a title 15 high.
// Inside a block everything is multiplied by the block's `inner` scale.

export const LEAF_MIN_W = 150;
export const LEAF_H = 58;
export const HEADER = 26;              // the title strip at the top of a block which holds others
export const TITLE_PX = 14;            // the size of that title
export const LABEL_PX = 14;            // the label of a leaf
export const SUB_PX = 11;              // its id and summary
export const SHAPE_PX = 10;            // the shape on an arrow
const BODY_PAD = 8;                    // between a block's border and what it holds
const BLOCK_AREA = 220 * 110;          // about how big a block which holds others is
const BLOCK_MIN_W = 180, BLOCK_MAX_W = 340;
const BODY_MIN_H = 36, BODY_MAX_H = 200;

const elkOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '10',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.json.edgeCoords': 'ROOT',
  'elk.json.shapeCoords': 'PARENT',
};
/**
 * The graph for elkjs of what is inside `node`: its children as blocks of
 * the size `sizes` gives (path -> {w, h}), with ports for every place an edge
 * attaches, and its edges. The space between columns is enough for the
 * longest shape written on an arrow. `wrap` breaks a long row into rows.
 * `pinned` (path -> port name -> {x, y}) fixes where the ports of children
 * which hold others are: level with where their own insides take the edge on.
 */
export function innerGraph(node, sizes, measure, wrap = false, pinned = new Map()) {
  const own = new Map();
  const childPorts = new Map(node.children.map((c) => [c, new Map()]));
  const edges = node.edges.map((edge) => {
    const a = endpointPort(edge.from, 'from', node);
    const b = endpointPort(edge.to, 'to', node);
    for (const end of [a, b]) (end.owner === node ? own : childPorts.get(end.owner)).set(end.name, true);
    return {
      id: edge.key,
      sources: [portId(a.owner, a.name)],
      targets: [portId(b.owner, b.name)],
    };
  });
  const longest = Math.max(0, ...node.edges.map((e) => measure(formatShape(e.shape), SHAPE_PX)));
  const portList = (table, owner) =>
    [...table.keys()].sort().map((name) => {
      const at = pinned.get(owner.path) && pinned.get(owner.path)[name];
      return {
        id: portId(owner, name),
        width: 0, height: 0,
        ...(at ? { x: at.x, y: at.y } : {}),
        layoutOptions: { 'elk.port.side': name.startsWith('@in') ? 'WEST' : 'EAST' },
      };
    });
  const constraints = (c) => {
    const at = pinned.get(c.path);
    const all = at && [...childPorts.get(c).keys()].every((name) => at[name]);
    return all ? 'FIXED_POS' : 'FIXED_SIDE';
  };
  const options = {
    ...elkOptions,
    'elk.padding': '[top=12,left=14,bottom=12,right=14]',
    'elk.portConstraints': 'FIXED_SIDE',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.max(56, Math.ceil(longest) + 2 * SHAPE_PX)),
  };
  if (wrap) {
    Object.assign(options, {
      'elk.layered.wrapping.strategy': 'MULTI_EDGE',
      'elk.aspectRatio': '2.5',
      'elk.layered.wrapping.multiEdge.improveCuts': 'true',
      'elk.layered.wrapping.multiEdge.improveWrappedEdges': 'true',
      'elk.layered.wrapping.additionalEdgeSpacing': '14',
    });
  }
  const box = {
    id: node.path,
    layoutOptions: options,
    ports: portList(own, node),
    children: node.children.map((c) => ({
      id: c.path,
      width: sizes.get(c.path).w,
      height: sizes.get(c.path).h,
      ports: portList(childPorts.get(c), c),
      layoutOptions: { 'elk.portConstraints': constraints(c) },
    })),
    edges,
  };
  // The node sits inside an invisible one: elkjs fails on edges attached to
  // the ports of the very root of the graph it is given.
  return { id: '__world', layoutOptions: { ...elkOptions }, children: [box], edges: [] };
}

/** Reads elkjs's answer for `innerGraph(node)` into coordinates relative to the box's corner. */
function readInner(node, laid) {
  const box = laid.children[0];
  const ox = box.x || 0, oy = box.y || 0;
  const name = (id) => id.slice(id.indexOf('#') + 1);
  const portsOf = (e, x, y) => Object.fromEntries((e.ports || []).map((p) => [
    name(p.id), { x: x + (p.x || 0) + (p.width || 0) / 2, y: y + (p.y || 0) + (p.height || 0) / 2 },
  ]));
  const children = new Map();
  for (const c of box.children || []) {
    children.set(c.id, { x: c.x, y: c.y, w: c.width, h: c.height, ports: portsOf(c, c.x, c.y) });
  }
  const routes = new Map();
  for (const e of box.edges || []) {
    const s = e.sections && e.sections[0];
    if (!s) continue;
    routes.set(e.id, [s.startPoint, ...(s.bendPoints || []), s.endPoint].map((p) => ({ x: p.x - ox, y: p.y - oy })));
  }
  return { w: box.width, h: box.height, ports: portsOf(box, 0, 0), children, routes };
}

/**
 * Where the shape of each edge is written: just above the middle of its
 * longest horizontal run, if the text fits along it and lands on no other
 * label and no block. Edge key -> {x, y}, the middle of the text. All in the
 * coordinates of the routes.
 */
export function placeLabels(edges, routes, blocks, measure) {
  const placed = new Map();
  const taken = [...blocks.values()].map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }));
  for (const edge of edges) {
    const route = routes.get(edge.key);
    if (!route) continue;
    const need = measure(formatShape(edge.shape), SHAPE_PX) + SHAPE_PX;
    let best = null;
    for (let i = 0; i + 1 < route.length; i++) {
      const a = route[i], b = route[i + 1];
      if (Math.abs(a.y - b.y) > 0.5) continue;
      const l = Math.abs(b.x - a.x);
      if (!best || l > best.l) best = { x: (a.x + b.x) / 2, y: a.y, l };
    }
    if (!best || best.l < need) continue;
    const at = { x: best.x, y: best.y - SHAPE_PX * 0.75 };
    const box = { x0: at.x - need / 2, x1: at.x + need / 2, y0: at.y - SHAPE_PX * 0.6, y1: at.y + SHAPE_PX * 0.6 };
    if (taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0)) continue;
    taken.push(box);
    placed.set(edge.key, at);
  }
  return placed;
}

/**
 * The block a node which holds others is drawn as, for an inside of
 * `inner.w × inner.h`: about the same area whatever it holds, shaped like it.
 */
export function blockSize(inner, titleWidth) {
  const aspect = inner.w / inner.h;
  const w = clamp(Math.max(Math.sqrt(BLOCK_AREA * aspect), titleWidth + 28), BLOCK_MIN_W, BLOCK_MAX_W);
  const body = clamp((w - 2 * BODY_PAD) / aspect + BODY_PAD, BODY_MIN_H, BODY_MAX_H);
  return { w, h: HEADER + body };
}

/** How the inside of a block of size `w × h` fits in it: the scale and where its corner goes. */
export function fitInside(inner, w, h) {
  const bw = w - 2 * BODY_PAD, bh = h - HEADER - BODY_PAD;
  const scale = Math.min(bw / inner.w, bh / inner.h);
  return { scale, dx: (w - inner.w * scale) / 2, dy: HEADER + (bh - inner.h * scale) / 2 };
}

/**
 * Lays out the whole tree, every block in its parent, and writes onto every
 * node `x, y, w, h` (the block, in the root's units), `unit` (how much the
 * frame it is drawn in is scaled: 1 for the root and its children) and
 * `ports` (name -> {x, y}, where edges outside it attach). A node which
 * holds others also gets `inner` (the scale of what is inside it) and
 * `innerPorts` (where its own edges attach, inside); its edges get `route`,
 * a list of points, `labelAt`, the middle of where their shape is written,
 * and `unit`, the scale they are drawn at.
 * `measure(text, px, weight)` is the width of a text; `elk` an ELK instance.
 */
export async function layout(elk, root, measure) {
  const sizes = new Map();
  const inners = new Map();
  const pinned = new Map();

  async function size(node) {
    if (node.children.length === 0) {
      const text = Math.max(measure(node.label, LABEL_PX, 600), measure(node.id, SUB_PX));
      sizes.set(node.path, { w: Math.max(LEAF_MIN_W, Math.ceil(text) + 28), h: LEAF_H });
      return;
    }
    for (const c of node.children) await size(c);
    let inner = readInner(node, await elk.layout(innerGraph(node, sizes, measure, false, pinned)));
    const title = measure(node.label, TITLE_PX, 600);
    // A long chain of layers is a strip many times wider than high, and comes
    // out tiny in a block: broken into rows it may fill it better. Only for
    // one way in and one way out (edges to more outputs, like the skips of a
    // U-Net encoder, would all have to go back across the rows), and only
    // when much better, rows being harder to follow than a line.
    const outer = Object.keys(inner.ports);
    const simple = outer.filter((p) => p.startsWith('@in')).length === 1 && outer.length === 2;
    if (node.parent && simple && inner.w / inner.h > 4) {
      const wrapped = readInner(node, await elk.layout(innerGraph(node, sizes, measure, true, pinned)));
      const scale = (i) => { const b = blockSize(i, title); return fitInside(i, b.w, b.h).scale; };
      if (scale(wrapped) > 1.25 * scale(inner)) inner = wrapped;
    }
    inners.set(node.path, inner);
    // The root is not a block in anything: it is as big as what it holds.
    const block = node.parent
      ? blockSize(inner, title)
      : { w: Math.max(inner.w + 2 * BODY_PAD, title + 28), h: HEADER + inner.h + BODY_PAD };
    sizes.set(node.path, block);
    // An edge reaches the block on its border level with where it goes on inside.
    const fit = fitInside(inner, block.w, block.h);
    pinned.set(node.path, Object.fromEntries(Object.entries(inner.ports).map(([name, p]) => [
      name, { x: name.startsWith('@in') ? 0 : block.w, y: fit.dy + p.y * fit.scale },
    ])));
  }
  await size(root);

  const r = sizes.get(root.path);
  Object.assign(root, { x: 0, y: 0, w: r.w, h: r.h, unit: 1 });
  (function place(node) {
    if (node.children.length === 0) return;
    const inner = inners.get(node.path);
    const local = node.w / node.unit, localH = node.h / node.unit;
    const fit = fitInside(inner, local, localH);
    const s = node.unit * fit.scale;
    const ox = node.x + fit.dx * node.unit, oy = node.y + fit.dy * node.unit;
    const at = (p) => ({ x: ox + p.x * s, y: oy + p.y * s });
    node.inner = s;
    node.innerPorts = Object.fromEntries(Object.entries(inner.ports).map(([k, p]) => [k, at(p)]));
    if (!node.parent) node.ports = node.innerPorts;
    for (const c of node.children) {
      const b = inner.children.get(c.path);
      Object.assign(c, { x: ox + b.x * s, y: oy + b.y * s, w: b.w * s, h: b.h * s, unit: s });
      c.ports = Object.fromEntries(Object.entries(b.ports).map(([k, p]) => [k, at(p)]));
      place(c);
    }
    const labels = placeLabels(node.edges, inner.routes, inner.children, measure);
    for (const edge of node.edges) {
      const route = inner.routes.get(edge.key);
      edge.route = route ? route.map(at) : null;
      edge.labelAt = labels.has(edge.key) ? at(labels.get(edge.key)) : null;

      edge.unit = s;
    }
  })(root);
  if (root.children.length === 0) root.ports = {};
  return root;
}

// ------------------------------------------------- level of detail (zoom) ---

/**
 * How far a block shows what is inside it at zoom `k`, from 0 (its summary)
 * to 1 (its children). It opens as the children's labels get readable (5 to
 * 8 pixels), or as the block takes up the view (a third to a half of it,
 * either way), whichever comes first: a block which fills the screen shows
 * what it is made of, even if that needs a closer look to read. The root is
 * always open. `viewport` is {width, height} in pixels.
 */
export function openness(node, k, viewport) {
  if (node.children.length === 0) return 0;
  if (!node.parent) return 1;
  const readable = smoothstep(5, 8, LABEL_PX * node.inner * k);
  const share = Math.max(node.w * k / viewport.width, node.h * k / viewport.height);
  return Math.max(readable, smoothstep(0.33, 0.5, share));
}

/** How visible a text of `px` pixels on screen is: none below 4, all from 6.5. */
export function legibility(px) {
  return smoothstep(4, 6.5, px);
}

/** The zoom which makes the smallest text of the network `px` high: as far as zooming in is useful. */
export function maxZoom(tree, px = 28) {
  let unit = 1;
  for (const n of tree.byPath.values()) unit = Math.min(unit, n.unit);
  return px / (LABEL_PX * unit);
}

function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ text ---

export function shorten(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Word wrap of `text` into lines of at most `max` characters, at most `lines` of them. */
export function wrap(text, max, lines) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > max) { out.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = shorten(out[lines - 1] + '…', max);
  }
  return out;
}
