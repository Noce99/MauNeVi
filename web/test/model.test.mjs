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

function checkLaidOut(tree, expectShown) {
  const r = tree.root;
  let shown = 0;
  for (const node of tree.byPath.values()) {
    if (!node.shown) continue;
    shown++;
    for (const v of [node.x, node.y, node.w, node.h]) assert.ok(Number.isFinite(v), `${node.path}`);
    assert.ok(node.w > 0 && node.h > 0, node.path);
    assert.ok(node.x >= r.x - 1 && node.y >= r.y - 1, `${node.path} left of the root`);
    assert.ok(node.x + node.w <= r.x + r.w + 1 && node.y + node.h <= r.y + r.h + 1, `${node.path} outside the root`);
    if (node.parent) {
      const p = node.parent;
      assert.ok(p.open, `${node.path} is shown inside a node which is not open`);
      assert.ok(node.x >= p.x - 1 && node.x + node.w <= p.x + p.w + 1, `${node.path} outside its parent`);
      assert.ok(node.y >= p.y - 1 && node.y + node.h <= p.y + p.h + 1, `${node.path} outside its parent`);
    }
    for (const edge of node.edges) {
      if (!node.open) { assert.equal(edge.route, null, edge.key); continue; }
      assert.ok(edge.route && edge.route.length >= 2, `edge ${edge.key} has no route`);
      for (const p of edge.route) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), edge.key);
        // In the root's coordinates, not those of the node holding the edge.
        assert.ok(p.x >= r.x - 40 && p.x <= r.x + r.w + 40 && p.y >= r.y - 40 && p.y <= r.y + r.h + 40, `${edge.key} at ${p.x},${p.y}`);
      }
    }
  }
  assert.equal(shown, expectShown);
  // It reads left to right: the root's input is at its left side, its output at its right.
  const ports = r.ports;
  assert.ok(ports['@in'], 'the root has an input port');
  const outs = Object.keys(ports).filter((n) => n.startsWith('@out'));
  assert.ok(outs.length > 0, 'the root has an output port');
  for (const name of outs) assert.ok(ports[name].x > ports['@in'].x, name);
}

for (const [name, version] of [['tree', '0.1'], ['unet', '0.2']]) {
  test(`${name} ${version} with everything open: every block placed and every edge routed`, async () => {
    const tree = m.buildTree(load('image_to_omap', name, version));
    await m.layout(new ELK(), tree.root, measure, m.allContainers(tree));
    checkLaidOut(tree, tree.byPath.size);
    assert.ok(tree.byPath.size > 20);
  });

  test(`${name} ${version} with only the root open is a handful of blocks and reads at a glance`, async () => {
    const tree = m.buildTree(load('image_to_omap', name, version));
    await m.layout(new ELK(), tree.root, measure);
    checkLaidOut(tree, 1 + tree.root.children.length);
    // The far view is readable: blocks no more than a few times wider than high.
    assert.ok(tree.root.w / tree.root.h < 6, `${tree.root.w} x ${tree.root.h}`);
    for (const c of tree.root.children) assert.equal(c.open, false);
  });
}

test('opening a block lays out what is inside it and nothing deeper', async () => {
  const tree = m.buildTree(load('image_to_omap', 'tree', '0.1'));
  const set = m.toggled(new Set(), 'tree_net/encoder', true);
  await m.layout(new ELK(), tree.root, measure, set);
  const encoder = tree.byPath.get('tree_net/encoder');
  assert.equal(encoder.open, true);
  const down0 = tree.byPath.get('tree_net/encoder/down0');
  assert.equal(down0.shown, true);
  assert.equal(down0.open, false);
  assert.equal(tree.byPath.get('tree_net/encoder/down0/conv1').shown, false);
  // The block it was is small; open it is wider than its children together.
  assert.ok(encoder.w > down0.w * 4);
});

test('a block opens when it is big on screen, an open node closes when it is small, and not both at once', async () => {
  const tree = m.buildTree(load('image_to_omap', 'tree', '0.1'));
  await m.layout(new ELK(), tree.root, measure);
  const vp = { width: 1200, height: 800 };
  const encoder = tree.byPath.get('tree_net/encoder');
  const { open: openPx, close: closePx } = m.thresholds(encoder);
  assert.ok(closePx < openPx);
  // Centred, at a zoom where the encoder block is just short of its threshold and just past it.
  const at = (k) => ({ k, tx: 600 - (encoder.x + encoder.w / 2) * k, ty: 400 - (encoder.y + encoder.h / 2) * k });
  assert.equal(m.decideToggle(tree.root, at((openPx - 5) / encoder.w), vp), null);
  assert.deepEqual(m.decideToggle(tree.root, at((openPx + 5) / encoder.w), vp), { path: 'tree_net/encoder', open: true });

  // Opened, at the same width on screen: the encoder is not asked to close, and
  // shrinking it enough does close it.
  await m.layout(new ELK(), tree.root, measure, m.toggled(new Set(), 'tree_net/encoder', true));
  const kOpen = (openPx + 5) / encoder.w;
  const view = (k) => ({ k, tx: 600 - (encoder.x + encoder.w / 2) * k, ty: 400 - (encoder.y + encoder.h / 2) * k });
  assert.notDeepEqual(m.decideToggle(tree.root, view(kOpen), vp), { path: 'tree_net/encoder', open: false });
  assert.deepEqual(m.decideToggle(tree.root, view((closePx - 5) / encoder.w), vp), { path: 'tree_net/encoder', open: false });
});

test('a block with more in it opens later, so that what is inside comes out readable', async () => {
  const tree = m.buildTree(load('image_to_omap', 'tree', '0.1'));
  const encoder = tree.byPath.get('tree_net/encoder');            // 8 children
  const curves = tree.byPath.get('tree_net/curves_head');          // 4 children
  assert.ok(m.thresholds(encoder).open > m.thresholds(curves).open);
  for (const n of [encoder, curves]) {
    const t = m.thresholds(n);
    assert.ok(t.open >= 340 && t.open <= 900 && t.close >= 160 && t.close < t.open, JSON.stringify(t));
  }
});

test('a block off the screen is left as it is', async () => {
  const tree = m.buildTree(load('image_to_omap', 'tree', '0.1'));
  await m.layout(new ELK(), tree.root, measure);
  const k = 5;
  // Looking at a place well to the right of the whole network.
  const view = { k, tx: -(tree.root.x + tree.root.w + 500) * k, ty: 0 };
  assert.equal(m.decideToggle(tree.root, view, { width: 1000, height: 700 }), null);
});

test('toggled closes everything below, and revealed opens every ancestor', async () => {
  const tree = m.buildTree(load('image_to_omap', 'unet', '0.2'));
  const open = new Set(['unet/decoder', 'unet/decoder/up0', 'unet/decoder/up0/conv', 'unet/decoder/up1']);
  assert.deepEqual([...m.toggled(open, 'unet/decoder/up0', false)].sort(), ['unet/decoder', 'unet/decoder/up1']);
  assert.deepEqual([...m.toggled(open, 'unet/encoder', true)].sort(), ['unet/decoder', 'unet/decoder/up0', 'unet/decoder/up0/conv', 'unet/decoder/up1', 'unet/encoder']);
  const deep = tree.byPath.get('unet/decoder/up0/conv/conv1');
  assert.deepEqual([...m.revealed(new Set(), deep)].sort(), ['unet/decoder', 'unet/decoder/up0', 'unet/decoder/up0/conv']);
});

test('wrap breaks at words and caps the lines', () => {
  assert.deepEqual(m.wrap('one two three four', 8, 5), ['one two', 'three', 'four']);
  const capped = m.wrap('aaaa bbbb cccc dddd eeee', 9, 2);
  assert.equal(capped.length, 2);
  assert.ok(capped[1].endsWith('…'));
});
