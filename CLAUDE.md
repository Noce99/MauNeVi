# CLAUDE.md

MauNeVi (MAUro NEtworks VIsualizer) shows the neural networks of MaUR-O as
zoomable block diagrams. It is two small parts:

- `src/` — an axum service which serves a folder of descriptors (MaUR-O's
  `networks/`, written by `mauro net describe`) and the viewer in `web/`. It
  holds nothing: every request reads the folder.
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
- **Semantic zoom is relayout, not scaling.** A block which is not open is a
  fixed-size block, whatever it holds. When it gets wide enough on screen
  (`thresholds` in `model.js`, which depends on how many children it has) it
  *opens*: the graph is laid out again with it open and the view is remapped
  (`setOpen` in `app.js`) so what is under the pointer stays under it. Zooming
  out closes it again. Never lay out the whole tree expanded: a chain of
  layers is a strip fifty times wider than high.
- elkjs fails on edges attached to the ports of the graph's *root*, so the
  network is wrapped in an invisible `__world` node (`toElk`).
- The page uses relative URLs only, so it works under a reverse proxy prefix.
