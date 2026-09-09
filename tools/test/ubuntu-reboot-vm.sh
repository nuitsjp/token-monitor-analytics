#!/usr/bin/env bash
set -Eeuo pipefail

# Run the Ubuntu user-service acceptance in an isolated QEMU guest. The guest
# owns all paths under /opt and /var/lib; this script never invokes the host's
# provision, configure, publish, systemd, or reboot commands.

source_dir=''
node_bin=''
artifact_dir=''
image_url=''
image_sha256=''

usage() {
  cat >&2 <<'EOF'
Usage: ubuntu-reboot-vm.sh --source-dir DIR --node-bin FILE --artifact-dir DIR \
  --image-url URL --image-sha256 HEX
EOF
}

while (($#)); do
  case "$1" in
    --source-dir) source_dir=${2:?missing --source-dir value}; shift 2 ;;
    --node-bin) node_bin=${2:?missing --node-bin value}; shift 2 ;;
    --artifact-dir) artifact_dir=${2:?missing --artifact-dir value}; shift 2 ;;
    --image-url) image_url=${2:?missing --image-url value}; shift 2 ;;
    --image-sha256) image_sha256=${2:?missing --image-sha256 value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$source_dir" || -z "$node_bin" || -z "$artifact_dir" || -z "$image_url" || ! "$image_sha256" =~ ^[0-9a-fA-F]{64}$ ]]; then
  usage
  exit 2
fi
source_dir=$(cd "$source_dir" && pwd)
node_bin=$(readlink -f "$node_bin")
node_root=$(cd "$(dirname "$node_bin")/.." && pwd)
[[ -d "$source_dir/.git" ]] || { echo "source directory must be a clean Git checkout" >&2; exit 2; }
[[ -x "$node_bin" ]] || { echo "fixed Node binary is not executable: $node_bin" >&2; exit 2; }
[[ -x "$node_root/bin/npm" ]] || { echo "fixed Node installation must include npm: $node_root" >&2; exit 2; }
git -C "$source_dir" diff --exit-code
git -C "$source_dir" diff --cached --exit-code

for command in curl cloud-localds qemu-img qemu-system-x86_64 ssh scp ssh-keygen git sha256sum python3 tar timeout; do
  command -v "$command" >/dev/null || { echo "missing host command: $command" >&2; exit 2; }
done

mkdir -p "$artifact_dir"
artifact_dir=$(cd "$artifact_dir" && pwd)
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/tma-ubuntu-vm.XXXXXX")
vm_pid=''
cleanup() {
  local status=$?
  if [[ -n "$vm_pid" ]] && kill -0 "$vm_pid" 2>/dev/null; then
    kill "$vm_pid" 2>/dev/null || true
    wait "$vm_pid" 2>/dev/null || true
  fi
  cp -f "$work_dir/serial.log" "$artifact_dir/serial.log" 2>/dev/null || true
  cp -f "$work_dir/qemu.stderr.log" "$artifact_dir/qemu.stderr.log" 2>/dev/null || true
  rm -rf "$work_dir"
  exit "$status"
}
trap cleanup EXIT

base_image="$work_dir/ubuntu.img"
overlay_image="$work_dir/guest.qcow2"
seed_image="$work_dir/seed.img"
ssh_key="$work_dir/id_ed25519"
bundle="$work_dir/source.bundle"
node_runtime_archive="$work_dir/node-runtime.tar.gz"

echo "Downloading pinned Ubuntu image: $image_url"
curl --fail --location --retry 3 --output "$base_image" "$image_url"
printf '%s  %s\n' "$image_sha256" "$base_image" | sha256sum --check --status
qemu-img create -f qcow2 -F qcow2 -b "$base_image" "$overlay_image" 16G >/dev/null

ssh-keygen -q -t ed25519 -N '' -f "$ssh_key"
cat > "$work_dir/user-data" <<EOF
#cloud-config
users:
  - default
  - name: tma
    gecos: Token Monitor Analytics acceptance
    groups: [adm, sudo]
    shell: /bin/bash
    lock_passwd: true
    sudo: ["ALL=(ALL) NOPASSWD:ALL"]
    ssh_authorized_keys:
      - $(cat "$ssh_key.pub")
ssh_pwauth: false
EOF
cat > "$work_dir/meta-data" <<EOF
instance-id: tma-acceptance-28
local-hostname: tma-acceptance-28
EOF
cloud-localds --disk-format=raw "$seed_image" "$work_dir/user-data" "$work_dir/meta-data"

ssh_port=$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
)
ssh_opts=(-i "$ssh_key" -p "$ssh_port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=6)
scp_opts=(-i "$ssh_key" -P "$ssh_port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=6)
guest() { timeout --foreground 900s ssh "${ssh_opts[@]}" "tma@127.0.0.1" "$@"; }
guest_copy() { timeout --foreground 300s scp "${scp_opts[@]}" "$@"; }

# QEMU selects KVM when the hosted runner exposes it and falls back to the
# software accelerator in the same isolated invocation. The comma form is a
# machine property; `-accel kvm:tcg` is not a valid equivalent.
qemu-system-x86_64 \
  -machine q35,accel=kvm:tcg \
  -m 2048 \
  -smp 2 \
  -display none \
  -serial "file:$work_dir/serial.log" \
  -drive "if=virtio,format=qcow2,file=$overlay_image" \
  -drive "if=virtio,format=raw,readonly=on,file=$seed_image" \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$ssh_port-:22" \
  -device virtio-net-pci,netdev=net0 \
  >"$work_dir/qemu.stdout.log" 2>"$work_dir/qemu.stderr.log" &
vm_pid=$!

for attempt in $(seq 1 180); do
  if ! kill -0 "$vm_pid" 2>/dev/null; then
    echo 'QEMU exited before SSH became available' >&2
    tail -100 "$work_dir/serial.log" >&2 || true
    exit 1
  fi
  if guest true >/dev/null 2>&1; then break; fi
  sleep 2
  if ((attempt == 180)); then echo 'Timed out waiting for guest SSH' >&2; exit 1; fi
done

echo 'Installing guest prerequisites and transferring the clean checkout'
guest 'sudo env DEBIAN_FRONTEND=noninteractive apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git tar'
git -C "$source_dir" bundle create "$bundle" HEAD
tar -C "$node_root" -czf "$node_runtime_archive" .
guest_copy "$bundle" "tma@127.0.0.1:/tmp/tma-source.bundle"
guest_copy "$node_runtime_archive" "tma@127.0.0.1:/tmp/tma-node-runtime.tar.gz"
guest <<'EOF'
set -Eeuo pipefail
rm -rf /home/tma/node-runtime
mkdir -m 0755 /home/tma/node-runtime
tar -xzf /tmp/tma-node-runtime.tar.gz -C /home/tma/node-runtime
chmod 0755 /home/tma/node-runtime/bin/node
rm -rf /home/tma/repo
git clone --quiet /tmp/tma-source.bundle /home/tma/repo
sudo chown -R tma:tma /home/tma/repo
rm -f /tmp/tma-node-runtime.tar.gz /tmp/tma-source.bundle
EOF

echo 'Provisioning the isolated guest and publishing the native user service'
guest <<'EOF'
set -Eeuo pipefail
export PATH=/home/tma/node-runtime/bin:$PATH
cd /home/tma/repo
sudo env TMA_DEPLOY_USER=tma /home/tma/node-runtime/bin/node --experimental-strip-types tools/provision-ubuntu.mjs --apply --user tma
/home/tma/node-runtime/bin/node --experimental-strip-types tools/configure-ubuntu.mjs --port 18787 --listen-host 127.0.0.1 --viewer-mode loopback --public-origin http://127.0.0.1:18787
sha=$(git rev-parse HEAD)
/home/tma/node-runtime/bin/node --experimental-strip-types tools/publish-ubuntu.mjs --apply --architecture amd64 --target-sha "$sha"
systemctl --user is-enabled tma-analytics.service
systemctl --user is-active tma-analytics.service
if systemctl --user is-enabled --quiet tma-update.service; then
  echo 'update oneshot must not be enabled by provisioning' >&2
  exit 1
fi
curl --fail --silent --show-error http://127.0.0.1:18787/api/health | tee /tmp/tma-health-before.json
test -s /var/lib/tma-analytics/analytics.db
test -f /var/lib/tma-analytics/hub-secrets.json
EOF
guest 'systemctl --user status --no-pager tma-analytics.service' | tee "$artifact_dir/service-before-reboot.txt"
guest 'cat /tmp/tma-health-before.json' | tee "$artifact_dir/health-before-reboot.json"
boot_before=$(guest 'cat /proc/sys/kernel/random/boot_id')
printf '%s\n' "$boot_before" > "$artifact_dir/boot-before.txt"

echo 'Rebooting the guest (the host and its production services are untouched)'
guest 'sudo systemctl reboot' >/dev/null 2>&1 || true
sleep 4
for attempt in $(seq 1 60); do
  if ! guest true >/dev/null 2>&1; then break; fi
  sleep 1
done
for attempt in $(seq 1 180); do
  if ! kill -0 "$vm_pid" 2>/dev/null; then echo 'QEMU exited during guest reboot' >&2; exit 1; fi
  if guest true >/dev/null 2>&1; then break; fi
  sleep 2
  if ((attempt == 180)); then echo 'Timed out waiting for SSH after guest reboot' >&2; exit 1; fi
done

boot_after=$(guest 'cat /proc/sys/kernel/random/boot_id')
printf '%s\n' "$boot_after" > "$artifact_dir/boot-after.txt"
if [[ -z "$boot_before" || "$boot_before" == "$boot_after" ]]; then
  echo 'guest boot ID did not change; refusing to claim an OS reboot' >&2
  exit 1
fi

guest <<'EOF' | tee "$artifact_dir/service-after-reboot.txt"
set -Eeuo pipefail
systemctl --user is-enabled tma-analytics.service
systemctl --user is-active tma-analytics.service
if systemctl --user is-enabled --quiet tma-update.service; then
  echo 'update oneshot unexpectedly enabled after reboot' >&2
  exit 1
fi
curl --fail --silent --show-error http://127.0.0.1:18787/api/health | tee /tmp/tma-health-after.json
test -s /var/lib/tma-analytics/analytics.db
test -f /var/lib/tma-analytics/hub-secrets.json
systemctl --user status --no-pager tma-analytics.service
EOF
guest 'cat /tmp/tma-health-after.json' | tee "$artifact_dir/health-after-reboot.json"
echo 'PASS: isolated Ubuntu user service survived an actual guest reboot'
