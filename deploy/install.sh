#!/usr/bin/env bash
# Build MauNeVi and install / update it as a systemd service on noce-server.
# Run as enrico from anywhere: ~/MauNeVi/deploy/install.sh   (asks for the sudo password)
#
# First run also: clones MaUR-O's networks/ (sparse), excludes the build output
# from the restic backup and gives the app its HTTPS name https://maunevi.nutmade.org
# (svc-netns IP 10.99.2.13 + Caddy site). The NetBird resource and the DNS record
# are printed as reminders (they need the dashboard / token).
set -euo pipefail

REPO=/home/enrico/MauNeVi
MAURO=/home/enrico/MaUR-O
MAURO_BRANCH=random_map_dataset_creation   # the branch which has networks/ (master once merged)
DOCS=/home/enrico/server_documentation
CADDYFILE=/home/enrico/caddy/conf/Caddyfile
N=13            # NetBird resource 10.99.0.N, Caddy bind 10.99.2.N
PORT=8765
export PATH="$HOME/.cargo/bin:/opt/rust/cargo/bin:$PATH"

[[ $(id -un) == enrico ]] || { echo "run as enrico, not root (sudo is called when needed)"; exit 1; }

echo "== MaUR-O networks"
if [[ ! -d $MAURO/.git ]]; then
  git clone --filter=blob:none --sparse --branch "$MAURO_BRANCH" https://github.com/Noce99/MaUR-O.git "$MAURO"
  git -C "$MAURO" sparse-checkout set networks
fi
ls "$MAURO/networks/index.json"

echo "== Build"
cargo build --release --locked --manifest-path "$REPO/Cargo.toml"

echo "== Install binary and units"
sudo install -m 755 "$REPO/target/release/maunevi" /usr/local/bin/maunevi
for unit in maunevi.service maunevi-sync.service maunevi-sync.timer; do
  sudo install -m 644 "$REPO/deploy/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable maunevi.service maunevi-sync.timer
sudo systemctl restart maunevi.service
sudo systemctl start maunevi-sync.timer

echo "== Backup: exclude build output"
line="$REPO/target"
sudo grep -qxF "$line" /etc/restic/excludes || echo "$line" | sudo tee -a /etc/restic/excludes >/dev/null
grep -qxF "$line" "$DOCS/scripts/restic/excludes" \
  || echo "Reminder: add $line to $DOCS/scripts/restic/excludes"

echo "== HTTPS name: svc-netns IP 10.99.2.$N"
if ! sudo grep -q "$N:maunevi" /usr/local/sbin/svc-netns; then
  if grep -q "$N:maunevi" "$DOCS/scripts/netbird/svc-netns.sh"; then
    echo "Changes to /usr/local/sbin/svc-netns:"
    diff /usr/local/sbin/svc-netns "$DOCS/scripts/netbird/svc-netns.sh" || true
    read -rp "Install this version and restart svc-netns (all services blink for a second)? [y/N] " ok
    if [[ $ok == y ]]; then
      sudo install -m 755 "$DOCS/scripts/netbird/svc-netns.sh" /usr/local/sbin/svc-netns
      sudo systemctl restart svc-netns
    fi
  else
    echo "Add '$N:maunevi' to the service list in $DOCS/scripts/netbird/svc-netns.sh, then run this again."
  fi
fi

echo "== HTTPS name: Caddy site maunevi.nutmade.org"
if ! grep -q '^maunevi\.nutmade\.org' "$CADDYFILE"; then
  printf 'maunevi.nutmade.org {\n\timport svc 10.99.2.%s 127.0.0.1:%s\n}\n' "$N" "$PORT" >> "$CADDYFILE"
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile
  echo "Added the site to $CADDYFILE; certificate in ~1 min: docker logs caddy --since 2m | grep obtained"
fi

echo "== Check"
sleep 2
systemctl --no-pager --lines=5 status maunevi.service || true
curl -fsS "http://127.0.0.1:$PORT/api/health" && echo " ← health"

cat <<EOT

If not done yet (once):
  - NetBird dashboard → Networks → server-services → Add resource "maunevi",
    address 10.99.0.$N/32, groups svc-all + a new group svc-maunevi
  - DNS: $DOCS/scripts/netbird/cf-dns.sh maunevi 10.99.0.$N
Then open https://maunevi.nutmade.org
EOT
