# CLAUDE.md

MauNeVi (MAUro NEtworks VIsualizer) shows the neural networks of MaUR-O as
zoomable block diagrams. It is two small parts:

- `src/` — an axum service which serves a folder of descriptors (MaUR-O's
  `networks/`, written by `mauro net describe`) and the viewer in `web/`. It
  holds nothing: every request reads the folder. The one thing it may change is
  that checkout: `POST /api/pull` (`git pull --ff-only`), only if
  `MAUNEVI_PULL_REPO` is set.
- `web/` — a static page, no build step. `model.js` is pure (descriptor ->
  ELK graph, layout, level-of-detail decisions) and tested under node;
  `app.js` is the DOM. `vendor/elk.bundled.js` is elkjs, vendored.

## Commands

```bash
cargo test                          # service
node --test web/test/*.test.mjs     # viewer model (also lays out the fixtures with elkjs)
cargo fmt --all --check && cargo clippy --all-targets --locked -- -D warnings
MAUNEVI_NETWORKS_DIR=tests/fixtures/networks cargo run   # http://127.0.0.1:8765/
```

## Things to know

- **Descriptor format** is defined in MaUR-O (`src/net/describe.rs`); this repo
  only reads it. `tests/fixtures/networks/` is a copy of MaUR-O's `networks/`:
  refresh it (`cp -r`) when the format or a network changes, and the tests
  show what the viewer needs to follow.
- **A block keeps its size; what it holds is drawn inside it, smaller.**
  `layout` in `model.js` lays out every node's children on their own
  (bottom-up, one elkjs call per node), sizes the node's block from that
  (`blockSize`: about the same area, shaped like what it holds) and shrinks
  the inside to fit below the block's title (`fitInside`). The result is one
  fixed drawing: zooming only scales it, text included, so labels keep their
  size relative to their block. What changes with the zoom is `openness`: a
  block fades from its summary to its children once they would be readable,
  or once it takes up much of the view. Never relayout on zoom.
- Every node has `unit`, the scale of the frame it is drawn in, and a node
  which holds others `inner`, the scale of its insides: every size the page
  draws is one of the constants in `model.js` (`LABEL_PX`, `HEADER`, …) times
  one of those times the zoom.
- A block's outer ports are pinned (elkjs `FIXED_POS`) level with where its
  insides take each edge on, so an arrow goes straight through the border.
- A long single-in single-out chain may be wrapped into rows, if that makes
  its insides clearly bigger; anything with more outputs stays one row (the
  skips of a U-Net encoder would all cross the rows).
- elkjs fails on edges attached to the ports of the graph's *root*, so the
  graph of every node is wrapped in an invisible `__world` node (`innerGraph`).
- The page uses relative URLs only, so it works under a reverse proxy prefix.
