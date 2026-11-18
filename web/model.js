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

const LEAF_MIN_W = 150;
const LEAF_H = 58;
const BLOCK_W = 200;
const BLOCK_H = 78;
export const PAD_TOP = 40;
const PAD = 16;

/** Is this node drawn opened, its children inside it? The root always is. */
export function isOpenIn(node, openSet) {
  return node.children.length > 0 && (node.parent === null || openSet.has(node.path));
}

/**
 * The graph for elkjs: one ELK node per descriptor node *which is shown*,
 * ports for every place an edge attaches, and the edges in the node which
 * holds them. A node which is not open is a block of fixed size, whatever it
 * holds, so the layout of the whole is only as big as what is opened.
 * `measure(text, px, weight)` is the width of a text.
 */
export function toElk(root, measure, openSet = new Set()) {
  const layoutOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.spacing.nodeNode': '28',
    'elk.layered.spacing.nodeNodeBetweenLayers': '64',
    'elk.spacing.edgeNode': '20',
    'elk.spacing.edgeEdge': '12',
    'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    'elk.json.edgeCoords': 'ROOT',
    'elk.json.shapeCoords': 'PARENT',
  };

  function build(node) {
    const elk = { id: node.path, layoutOptions: {}, ports: [], edges: [], children: [] };
    if (!isOpenIn(node, openSet)) {
      // A block. Its ports are declared by whoever holds the edges.
      const container = node.children.length > 0;
      const text = Math.max(measure(node.label, 14, 600), measure(node.id, 11));
      elk.width = Math.max(container ? BLOCK_W : LEAF_MIN_W, Math.ceil(text) + 32);
      elk.height = container ? BLOCK_H : LEAF_H;
      elk.layoutOptions['elk.portConstraints'] = 'FIXED_SIDE';
      return elk;
    }
    elk.children = node.children.map(build);
    // Ports of this node itself: the boundary ones its own edges start or end
    // at. Those of its children are the children's own to declare, so they
    // are collected here and handed to each child.
    const own = new Map();
    const childPorts = new Map(node.children.map((c) => [c, new Map()]));
    node.edges.forEach((edge) => {
      const a = endpointPort(edge.from, 'from', node);
      const b = endpointPort(edge.to, 'to', node);
      for (const end of [a, b]) {
        const table = end.owner === node ? own : childPorts.get(end.owner);
        table.set(end.name, true);
      }
      elk.edges.push({
        id: edge.key,
        sources: [portId(a.owner, a.name)],
        targets: [portId(b.owner, b.name)],
      });
    });
    const portList = (table, owner) =>
      [...table.keys()].sort().map((name) => ({
        id: portId(owner, name),
        layoutOptions: { 'elk.port.side': name.startsWith('@in') ? 'WEST' : 'EAST' },
      }));
    elk.ports = portList(own, node);
    for (const child of elk.children) {
      const owner = node.children.find((c) => c.path === child.id);
      child.ports = portList(childPorts.get(owner), owner);
    }
    Object.assign(elk.layoutOptions, layoutOptions, {
      'elk.padding': `[top=${PAD_TOP},left=${PAD},bottom=${PAD},right=${PAD}]`,
      'elk.portConstraints': 'FIXED_SIDE',
    });
    return elk;
  }
  // The network sits inside an invisible node of its own: elkjs fails on
  // edges attached to the ports of the very root of the graph it is given,
  // and the network's input and output are exactly that.
  return {
    id: '__world',
    layoutOptions: { ...layoutOptions },
    children: [build(root)],
    edges: [],
  };
}

export function shorten(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/**
 * Reads elkjs's answer back onto the descriptor's nodes and edges. A node
 * which was laid out gets `shown`, `open`, `x, y, w, h` in the root's
 * coordinates and `ports` (name -> {x, y}, the same); one inside a closed
 * block is not `shown` and has no geometry worth reading. An edge of an open
 * node gets `route`, a list of points in the root's coordinates.
 */
export function applyLayout(root, laid) {
  const elkNodes = new Map();
  (function index(e) { elkNodes.set(e.id, e); (e.children || []).forEach(index); })(laid);
  const edgeRoutes = new Map();
  (function collect(e) {
    for (const edge of e.edges || []) edgeRoutes.set(edge.id, edge);
    (e.children || []).forEach(collect);
  })(laid);

  (function place(node, ox, oy) {
    const e = elkNodes.get(node.path);
    node.shown = Boolean(e);
    node.open = Boolean(e) && (e.children || []).length > 0;
    for (const edge of node.edges) edge.route = null;
    if (!e) { node.children.forEach((c) => place(c, 0, 0)); return; }
    node.x = ox + (e.x || 0);
    node.y = oy + (e.y || 0);
    node.w = e.width;
    node.h = e.height;
    node.ports = {};
    for (const p of e.ports || []) {
      const name = p.id.slice(p.id.indexOf('#') + 1);
      node.ports[name] = { x: node.x + (p.x || 0) + (p.width || 0) / 2, y: node.y + (p.y || 0) + (p.height || 0) / 2 };
    }
    for (const child of node.children) place(child, node.x, node.y);
    if (!node.open) return;
    for (const edge of node.edges) {
      const routed = edgeRoutes.get(edge.key);
      const section = routed && routed.sections && routed.sections[0];
      if (!section) continue;
      edge.route = [section.startPoint, ...(section.bendPoints || []), section.endPoint].map((p) => ({ x: p.x, y: p.y }));
    }
  })(root, 0, 0);
}

/** Runs the whole layout for the nodes in `openSet` opened. `elk` is an `ELK` instance. */
export async function layout(elk, root, measure, openSet = new Set()) {
  const graph = toElk(root, measure, openSet);
  const laid = await elk.layout(graph);
  applyLayout(root, laid);
  return root;
}

/** The paths of every node which has children: what "all open" is. */
export function allContainers(tree) {
  return new Set([...tree.byPath.values()].filter((n) => n.children.length > 0).map((n) => n.path));
}

// ------------------------------------------------- level of detail (zoom) ---

/**
 * How wide a block is on screen when it opens into its children, and how
 * narrow an open node gets before it closes into a block again.
 *
 * Opening is when the children would come out readable, about 70 pixels each,
 * which depends on how many there are: a block of four opens at about 390
 * pixels and one of eight at about 780. Closing is at half of that, and the
 * gap between the two is what keeps a node from opening and closing on the
 * same zoom: opening keeps the node as wide on screen as it was.
 */
export function thresholds(node) {
  const widths = node.children.map((c) => (c.children.length > 0 ? BLOCK_W : LEAF_MIN_W));
  const total = widths.reduce((a, b) => a + b, 0) + 64 * Math.max(0, widths.length - 1) + 2 * PAD;
  const average = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : LEAF_MIN_W;
  const open = clamp(70 * total / average, 340, 900);
  return { open, close: Math.max(160, open / 2) };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * What, if anything, the view says should open or close next: the outermost
 * open node which is too small (closing comes first), else the biggest block
 * which is big enough for what it holds. Only what is on the screen is asked.
 * Returns `{path, open}` or null. `view` is {k, tx, ty}, `viewport`
 * {width, height}.
 */
export function decideToggle(root, view, viewport) {
  const { k, tx, ty } = view;
  let closing = null;
  let opening = null;
  (function walk(n) {
    if (closing) return;
    const w = n.w * k;
    const x = n.x * k + tx;
    const y = n.y * k + ty;
    if (x >= viewport.width || y >= viewport.height || x + w <= 0 || y + n.h * k <= 0) return;
    if (n.open) {
      if (n.depth > 0 && w < thresholds(n).close) { closing = n; return; }
      n.children.forEach(walk);
    } else if (n.children.length > 0) {
      const over = w / thresholds(n).open;
      if (over >= 1 && (!opening || over > opening.over)) opening = { n, over };
    }
  })(root);
  if (closing) return { path: closing.path, open: false };
  if (opening) return { path: opening.n.path, open: true };
  return null;
}

/** `openSet` with `path` opened, or closed along with everything under it. */
export function toggled(openSet, path, open) {
  const next = new Set(openSet);
  if (open) { next.add(path); return next; }
  for (const p of openSet) {
    if (p === path || p.startsWith(path + SEP)) next.delete(p);
  }
  return next;
}

/** The set which opens every ancestor of `node`: what it takes for it to be shown. */
export function revealed(openSet, node) {
  const next = new Set(openSet);
  for (let p = node.parent; p; p = p.parent) if (p.parent) next.add(p.path);
  return next;
}

// ------------------------------------------------------------------ text ---

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
