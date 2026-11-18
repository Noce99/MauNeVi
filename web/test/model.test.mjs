import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as m from '../model.js';

const require = createRequire(import.meta.url);
const ELK = require('../vendor/elk.bundled.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '../../tests/fixtures/networks');
const measure = (text, px) => text.length * px * 0.6;

function load(scope, name, version) {
  return JSON.parse(fs.readFileSync(path.join(fixtures, scope, name, `${version}.json`), 'utf8'));
}

test('dimensions evaluate like the Rust side', () => {
  const s = { H: 64, C: 11 };
  assert.equal(m.evalDim('H/4', s), 16);
  assert.equal(m.evalDim('C+3', s), 14);
  assert.equal(m.evalDim('2*C+1', s), 23);
  assert.equal(m.evalDim('(C+1)*2', s), 24);
  assert.equal(m.evalDim(128, s), 128);
  assert.equal(m.evalDim('C/2', s), null);
  assert.equal(m.evalDim('W', s), null);
  assert.equal(m.evalDim('H/', s), null);
});

test('shape helpers', () => {
  const shape = ['B', 16, 'H/2', 'W/2'];
  assert.equal(m.formatShape(shape), 'B×16×H/2×W/2');
  assert.deepEqual(m.shapeSymbols(shape), ['B', 'H', 'W']);
  assert.deepEqual(m.concreteShape(shape, { B: 1, H: 64, W: 64 }), [1, 16, 32, 32]);
  assert.equal(m.concreteShape(shape, { B: 1 }), null);
  assert.equal(m.formatCount(1945742), '1,945,742');
});

test('endpoints resolve to ports', () => {
  const tree = m.buildTree({ root: { id: 'n', kind: 'model', label: 'n', param_count: 0,
    children: [{ id: 'a', kind: 'relu', label: 'a', param_count: 0 }, { id: 'b', kind: 'concat', label: 'b', param_count: 0 }],
    edges: [] } });
  const n = tree.root;
  const a = n.children[0];
  const b = n.children[1];
  assert.deepEqual(m.endpointPort('@in:skip', 'from', n), { owner: n, name: '@in:skip', boundary: true });
  assert.deepEqual(m.endpointPort('a', 'from', n), { owner: a, name: '@out', boundary: false });
  assert.deepEqual(m.endpointPort('b:skip', 'to', n), { owner: b, name: '@in:skip', boundary: false });
  assert.throws(() => m.endpointPort('ghost', 'to', n));
});

const inside = (a, b, slack = 0.5) =>
  a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function laidOut(name, version) {
  const tree = m.buildTree(load('image_to_omap', name, version));
  await m.layout(new ELK(), tree.root, measure);
  return tree;
}

for (const [name, version] of [['tree', '0.1'], ['unet', '0.1'], ['unet', '0.2']]) {
  test(`${name} ${version}: every block is inside the body of its parent, and none overlap`, async () => {
    const tree = await laidOut(name, version);
    assert.ok(tree.byPath.size > 20);
    for (const node of tree.byPath.values()) {
      for (const v of [node.x, node.y, node.w, node.h, node.unit]) assert.ok(Number.isFinite(v), node.path);
      assert.ok(node.w > 0 && node.h > 0, node.path);
      if (!node.parent) continue;
      const p = node.parent;
      // Below the parent's title, in the frame its insides are scaled to.
      const body = { x: p.x, y: p.y + m.HEADER * p.unit, w: p.w, h: p.h - m.HEADER * p.unit };
      assert.ok(inside(node, body, 0.5 * p.unit), `${node.path} outside the body of ${p.path}`);
      assert.equal(node.unit, p.inner, node.path);
      for (const other of p.children) {
        if (other !== node) assert.ok(!overlap(node, other), `${node.path} overlaps ${other.path}`);
      }
    }
  });

  test(`${name} ${version}: every edge is routed within the block which holds it`, async () => {
    const tree = await laidOut(name, version);
    for (const edge of tree.edges.values()) {
      const c = edge.container;
      assert.ok(edge.route && edge.route.length >= 2, `edge ${edge.key} has no route`);
      assert.equal(edge.unit, c.inner);
      for (const p of edge.route) {
        assert.ok(inside({ ...p, w: 0, h: 0 }, c, 1), `${edge.key} at ${p.x},${p.y} outside ${c.path}`);
      }
    }
  });

  test(`${name} ${version}: an edge reaches a block level with where it goes on inside`, async () => {
    const tree = await laidOut(name, version);
    let checked = 0;
    for (const node of tree.byPath.values()) {
      if (!node.parent || node.children.length === 0) continue;
      for (const [port, at] of Object.entries(node.innerPorts)) {
        const outer = node.ports[port];
        assert.ok(outer, `${node.path} has no outer ${port}`);
        assert.ok(Math.abs(outer.y - at.y) < 0.01 * node.h, `${node.path} ${port}: ${outer.y} vs ${at.y}`);
        // On the border it should be on: inputs left, outputs right.
        const side = port.startsWith('@in') ? node.x : node.x + node.w;
        assert.ok(Math.abs(outer.x - side) < 0.01 * node.w, `${node.path} ${port} not on its side`);
        checked++;
      }
    }
    assert.ok(checked > 10);
  });

  test(`${name} ${version}: it reads left to right`, async () => {
    const tree = await laidOut(name, version);
    const ports = tree.root.ports;
    assert.ok(ports['@in'], 'the root has an input port');
    const outs = Object.keys(ports).filter((n) => n.startsWith('@out'));
    assert.ok(outs.length > 0, 'the root has an output port');
    for (const out of outs) assert.ok(ports[out].x > ports['@in'].x, out);
  });
}

test('a block which holds others is about the same size whatever it holds, and not a long strip', async () => {
  for (const [name, version] of [['tree', '0.1'], ['unet', '0.2']]) {
    const tree = await laidOut(name, version);
    for (const node of tree.byPath.values()) {
      if (!node.parent || node.children.length === 0) continue;
      const w = node.w / node.unit, h = node.h / node.unit;  // in its own frame
      assert.ok(w >= 180 && w <= 340, `${node.path} is ${w} wide`);
      assert.ok(w / h < 6, `${node.path} is ${w} x ${h}`);
      // What it holds is smaller, and fills it one way or the other.
      const xs = node.children.map((c) => [c.x, c.x + c.w]).flat();
      const ys = node.children.map((c) => [c.y, c.y + c.h]).flat();
      const fill = Math.max((Math.max(...xs) - Math.min(...xs)) / node.w, (Math.max(...ys) - Math.min(...ys)) / (node.h - m.HEADER * node.unit));
      assert.ok(node.inner < node.unit && fill > 0.6, `${node.path}: inner ${node.inner}, fill ${fill}`);
    }
  }
});

test('a block shows its insides as it gets big on screen, and the root always does', async () => {
  const tree = await laidOut('tree', '0.1');
  const vp = { width: 1000, height: 700 };
  const encoder = tree.byPath.get('tree_net/encoder');
  const leaf = tree.byPath.get('tree_net/encoder/down0/conv1');
  assert.equal(m.openness(tree.root, 0.01, vp), 1);
  assert.equal(m.openness(leaf, 100, vp), 0);
  let last = -1;
  for (let k = 0.05; k < 200; k *= 1.3) {
    const t = m.openness(encoder, k, vp);
    assert.ok(t >= last && t >= 0 && t <= 1, `openness goes back at ${k}`);
    last = t;
  }
  // Small on screen: closed. Filling the view: open, readable or not.
  assert.equal(m.openness(encoder, 0.5, vp), 0);
  assert.equal(m.openness(encoder, (vp.width * 0.55) / encoder.w, vp), 1);
  // Readable children open it even when it is not that big.
  const leaves = tree.byPath.get('tree_net/leaves_head');
  const k = 9 / (m.LABEL_PX * leaves.inner);
  assert.ok(leaves.w * k < vp.width / 3);
  assert.equal(m.openness(leaves, k, { width: 1e6, height: 1e6 }), 1);
});

test('zooming in goes as far as makes the smallest text big', async () => {
  const tree = await laidOut('unet', '0.2');
  const smallest = Math.min(...[...tree.byPath.values()].map((n) => n.unit));
  assert.ok(Math.abs(m.LABEL_PX * smallest * m.maxZoom(tree) - 28) < 1e-6);
  assert.ok(smallest < 0.05, 'four levels deep is small');
});

test('shapes are written on their arrows, over nothing else', async () => {
  for (const [name, version] of [['tree', '0.1'], ['unet', '0.2']]) {
    const tree = await laidOut(name, version);
    let placed = 0;
    for (const container of tree.byPath.values()) {
      if (container.children.length === 0) continue;
      const boxes = [];
      for (const edge of container.edges) {
        if (!edge.labelAt) continue;
        placed++;
        const u = edge.unit;
        const w = (measure(m.formatShape(edge.shape), m.SHAPE_PX) + m.SHAPE_PX) * u;
        const box = { x: edge.labelAt.x - w / 2, y: edge.labelAt.y - m.SHAPE_PX * 0.6 * u, w, h: m.SHAPE_PX * 1.2 * u };
        // Just above a horizontal run of its own arrow, within it.
        const onRun = edge.route.some((a, i) => {
          const b = edge.route[i + 1];
          return b && Math.abs(a.y - b.y) < 0.01 && Math.abs(edge.labelAt.y + m.SHAPE_PX * 0.75 * u - a.y) < 0.01
            && box.x >= Math.min(a.x, b.x) - 0.01 && box.x + box.w <= Math.max(a.x, b.x) + 0.01;
        });
        assert.ok(onRun, `${edge.key}: label not on its arrow`);
        for (const b of boxes) assert.ok(!overlap(box, b), `${edge.key}: labels overlap`);
        for (const c of container.children) assert.ok(!overlap(box, c), `${edge.key}: label over ${c.path}`);
        boxes.push(box);
      }
    }
    // Most arrows have the room: the layout leaves it between columns.
    assert.ok(placed > tree.edges.size * 0.6, `${placed} of ${tree.edges.size}`);
  }
});

test('wrap breaks at words and caps the lines', () => {
  assert.deepEqual(m.wrap('one two three four', 8, 5), ['one two', 'three', 'four']);
  const capped = m.wrap('aaaa bbbb cccc dddd eeee', 9, 2);
  assert.equal(capped.length, 2);
  assert.ok(capped[1].endsWith('…'));
});
