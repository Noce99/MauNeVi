# MauNeVi

**MAUro NEtworks VIsualizer.** Shows the neural networks of
[MaUR-O](https://github.com/Noce99/MaUR-O) as block diagrams you can zoom into:
far away, the encoder, the decoder and the head; closer, the double
convolutions they are made of; closer still, layer by layer. Click a block for
what it holds, click an arrow for the shape of the tensor that flows along it.

Networks are grouped by what they are for (`image_to_omap` for now) and every
version a network has had is kept.

## How it gets its data

MauNeVi does not describe networks; MaUR-O does. Each network declares its
architecture next to its `forward`, and

```bash
mauro net describe          # in MaUR-O, after changing a network
```

writes a new version into MaUR-O's `networks/` folder if (and only if) the
architecture changed, and `--check` is what CI and a pre-commit hook run to
make sure nobody forgets. MauNeVi reads that folder:

```text
networks/
  index.json
  image_to_omap/tree/0.1.json
  image_to_omap/unet/0.1.json  0.2.json
```

It holds no copy: point it at a checkout of MaUR-O's `networks/`, and
publishing a version is a `git pull` there. Nothing to restart.

## Running it

```bash
cargo run --release                         # http://127.0.0.1:8765/
MAUNEVI_NETWORKS_DIR=../MaUR-O/networks cargo run --release
```

| Variable | Default | |
| --- | --- | --- |
| `MAUNEVI_NETWORKS_DIR` | `networks` | the folder of descriptors |
| `MAUNEVI_WEB_DIR` | `web` | the viewer's files |
| `MAUNEVI_BIND` | `127.0.0.1:8765` | where to listen |
| `MAUNEVI_BASE_PATH` | none | a prefix to serve under, if the proxy does not strip it |
| `MAUNEVI_PULL_REPO` | none | the git checkout the networks are in, for the page's *Pull from MaUR-O* button |

`GET /api/networks` is the index, `GET /api/networks/<scope>/<net>/<version>` a
descriptor, `GET /api/health` says `ok`; everything else is the viewer.

With `MAUNEVI_PULL_REPO` set, the page has a **Pull from MaUR-O** button, next
to *Fit*: `POST /api/pull` runs `git pull --ff-only` in that checkout, on
whatever branch is checked out there, so a new version shows without waiting
for the timer. It never merges: if the checkout has gone its own way the pull
fails and changes nothing. `GET /api/source` says which branch and commit the
checkout is at, and whether pulling is on. Anyone who can open the page can
press it; all it can do is bring the checkout up to date.

## As a service

`deploy/` has a systemd unit (`maunevi.service`), a timer which pulls the
MaUR-O checkout every ten minutes (`maunevi-sync.*`) and an nginx snippet for
serving it under a path. The units are the ones of noce-server
(`https://maunevi.nutmade.org`), where `deploy/install.sh` builds, installs
and restarts it, and sets up the HTTPS name the first time. Elsewhere, edit
the paths in the units to where you built it and where MaUR-O is checked out
(a sparse clone of `networks/` is enough), then
`systemctl enable --now maunevi maunevi-sync.timer`. The page only uses
relative URLs, so it works behind a proxy prefix as it is.

## The viewer

Scroll to zoom, drag to pan, double-click a block to zoom to it, `f` to fit
the whole network, `Esc` to deselect. Every block keeps its size: what it is
made of is laid out inside it (with [elkjs](https://github.com/kieler/elkjs)),
much smaller, and zooming in is like zooming into a picture, labels and all.
Far away a block shows its title and summary; as it grows on screen they give
way to the blocks it holds, and so on down to single layers. The version menu
switches between a network's versions; the URL (`#image_to_omap/unet/0.2`)
says which, so a view can be linked to.

Not yet: comparing two versions side by side.

## Development

```bash
cargo test                          # the service
node --test web/test/*.test.mjs     # the viewer's model, with elkjs laying out the fixtures
```

`tests/fixtures/networks/` is a copy of MaUR-O's `networks/`. See `CLAUDE.md`
for how the pieces fit.
