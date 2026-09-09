#!/usr/bin/env bash
set -Eeuo pipefail

# Run the Ubuntu user-service acceptance in an isolated QEMU guest. The guest
# owns all paths under /opt and /var/lib; this script never invokes the host's
# provision, configure, publish, systemd, or reboot commands.

source_dir=''
node_bin=''
mise_bin=''
artifact_dir=''
image_url=''
image_sha256=''
guest_stage_script=''
target_artifact=''

usage() {
  cat >&2 <<'EOF'
Usage: ubuntu-reboot-vm.sh --source-dir DIR --node-bin FILE --mise-bin FILE --artifact-dir DIR \
  --image-url URL --image-sha256 HEX

Optional guest stage mode (the same disposable QEMU boot is reused):
  --guest-stage-script FILE --target-artifact FILE
EOF
}

while (($#)); do
  case "$1" in
    --source-dir) source_dir=${2:?missing --source-dir value}; shift 2 ;;
    --node-bin) node_bin=${2:?missing --node-bin value}; shift 2 ;;
    --mise-bin) mise_bin=${2:?missing --mise-bin value}; shift 2 ;;
    --artifact-dir) artifact_dir=${2:?missing --artifact-dir value}; shift 2 ;;
    --image-url) image_url=${2:?missing --image-url value}; shift 2 ;;
    --image-sha256) image_sha256=${2:?missing --image-sha256 value}; shift 2 ;;
    --guest-stage-script) guest_stage_script=${2:?missing --guest-stage-script value}; shift 2 ;;
    --target-artifact) target_artifact=${2:?missing --target-artifact value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$source_dir" || -z "$node_bin" || -z "$mise_bin" || -z "$artifact_dir" || -z "$image_url" || ! "$image_sha256" =~ ^[0-9a-fA-F]{64}$ ]]; then
  usage
  exit 2
fi
if [[ -n "$guest_stage_script" && -z "$target_artifact" ]] || [[ -z "$guest_stage_script" && -n "$target_artifact" ]]; then
  echo '--guest-stage-script and --target-artifact must be supplied together' >&2
  exit 2
fi
source_dir=$(cd "$source_dir" && pwd)
node_bin=$(readlink -f "$node_bin")
mise_bin=$(readlink -f "$mise_bin")
if [[ -n "$guest_stage_script" ]]; then
  guest_stage_script=$(readlink -f "$guest_stage_script")
  target_artifact=$(readlink -f "$target_artifact")
  [[ -f "$guest_stage_script" && -x "$guest_stage_script" ]] || { echo "guest stage script must be an executable regular file: $guest_stage_script" >&2; exit 2; }
  [[ -f "$target_artifact" && -f "$target_artifact.sha256" ]] || { echo "target artifact and SHA sidecar are required: $target_artifact" >&2; exit 2; }
fi
node_root=$(cd "$(dirname "$node_bin")/.." && pwd)
node_npm_cli="$node_root/lib/node_modules/npm/bin/npm-cli.js"
[[ -d "$source_dir/.git" ]] || { echo "source directory must be a clean Git checkout" >&2; exit 2; }
[[ -x "$node_bin" ]] || { echo "fixed Node binary is not executable: $node_bin" >&2; exit 2; }
[[ -x "$node_root/bin/npm" ]] || { echo "fixed Node installation must include npm: $node_root" >&2; exit 2; }
[[ -f "$node_npm_cli" ]] || { echo "fixed Node installation must include the npm package: $node_npm_cli" >&2; exit 2; }
[[ -x "$mise_bin" ]] || { echo "fixed mise binary is not executable: $mise_bin" >&2; exit 2; }
[[ "$(git -C "$source_dir" rev-parse --is-shallow-repository)" == false ]] || { echo "VM fixture requires full Git history for its update remote" >&2; exit 2; }
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
node_runtime_tree="$work_dir/node-runtime"

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
guest_update() { timeout --foreground 1200s ssh "${ssh_opts[@]}" "tma@127.0.0.1" "$@"; }
guest_copy() { timeout --foreground 300s scp "${scp_opts[@]}" "$@"; }

# QEMU selects KVM when the hosted runner exposes it and falls back to the
# software accelerator in the same isolated invocation. The comma form is a
# machine property; `-accel kvm:tcg` is not a valid equivalent.
qemu-system-x86_64 \
  -machine q35,accel=kvm:tcg \
  -cpu max \
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

initial_ssh_deadline=$((SECONDS + 900))
initial_ssh_ready=false
while ((SECONDS < initial_ssh_deadline)); do
  if ! kill -0 "$vm_pid" 2>/dev/null; then
    echo 'QEMU exited before SSH became available' >&2
    tail -100 "$work_dir/serial.log" >&2 || true
    exit 1
  fi
  if guest true >/dev/null 2>&1; then initial_ssh_ready=true; break; fi
  sleep 2
done
if [[ "$initial_ssh_ready" != true ]]; then echo 'Timed out waiting for guest SSH' >&2; exit 1; fi

echo 'Installing guest prerequisites and transferring the clean checkout'
guest 'sudo env DEBIAN_FRONTEND=noninteractive apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git tar'
git -C "$source_dir" bundle create "$bundle" HEAD
mkdir -p "$node_runtime_tree/bin" "$node_runtime_tree/lib/node_modules"
cp -L "$node_bin" "$node_runtime_tree/bin/node"
cp -a "$node_root/bin/npm" "$node_runtime_tree/bin/npm"
if [[ -e "$node_root/bin/npx" ]]; then cp -a "$node_root/bin/npx" "$node_runtime_tree/bin/npx"; fi
cp -a "$node_root/lib/node_modules/npm" "$node_runtime_tree/lib/node_modules/npm"
tar -C "$node_runtime_tree" -czf "$node_runtime_archive" .
guest_copy "$bundle" "tma@127.0.0.1:/tmp/tma-source.bundle"
guest_copy "$node_runtime_archive" "tma@127.0.0.1:/tmp/tma-node-runtime.tar.gz"
guest_copy "$mise_bin" "tma@127.0.0.1:/tmp/tma-mise"
guest <<'EOF'
set -Eeuo pipefail
rm -rf /home/tma/node-runtime
mkdir -m 0755 /home/tma/node-runtime
tar -xzf /tmp/tma-node-runtime.tar.gz -C /home/tma/node-runtime
chmod 0755 /home/tma/node-runtime/bin/node
mkdir -p -m 0755 /home/tma/.local/bin
install -m 0755 /tmp/tma-mise /home/tma/.local/bin/mise
rm -rf /home/tma/repo
git clone --quiet /tmp/tma-source.bundle /home/tma/repo
sudo chown -R tma:tma /home/tma/repo
rm -f /tmp/tma-mise /tmp/tma-node-runtime.tar.gz /tmp/tma-source.bundle
EOF

if [[ -n "$guest_stage_script" ]]; then
  echo 'Running the requested migration stage inside the isolated guest'
  target_artifact_name=$(basename "$target_artifact")
  guest_copy "$guest_stage_script" "tma@127.0.0.1:/tmp/tma-guest-stage.sh"
  guest_copy "$target_artifact" "tma@127.0.0.1:/tmp/$target_artifact_name"
  guest_copy "$target_artifact.sha256" "tma@127.0.0.1:/tmp/$target_artifact_name.sha256"
  guest <<'EOF'
set -Eeuo pipefail
[[ "$(hostname -s)" == tma-acceptance-28 ]] || { echo 'unexpected disposable guest hostname' >&2; exit 1; }
printf '%s\n' tma-ubuntu-migration-qemu | sudo tee /run/tma-ubuntu-migration-guest >/dev/null
sudo chown root:root /run/tma-ubuntu-migration-guest
sudo chmod 0600 /run/tma-ubuntu-migration-guest
chmod 0755 /tmp/tma-guest-stage.sh
EOF
  guest_update "/tmp/tma-guest-stage.sh /home/tma/repo /home/tma/node-runtime/bin/node /tmp/$target_artifact_name /tmp/$target_artifact_name.sha256 /home/tma/migration-evidence" | tee "$artifact_dir/migration-stage.log"
  guest 'tar -C /home/tma/migration-evidence -czf - .' > "$artifact_dir/migration-evidence.tar.gz"
  echo 'PASS: isolated Ubuntu guest migration stage completed'
  exit 0
fi

echo 'Provisioning the isolated guest and publishing the native user service'
guest <<'EOF'
set -Eeuo pipefail
export PATH=/home/tma/node-runtime/bin:/home/tma/.local/bin:$PATH
cd /home/tma/repo
sudo env TMA_DEPLOY_USER=tma /home/tma/node-runtime/bin/node --experimental-strip-types tools/provision-ubuntu.mjs --apply --user tma
/home/tma/node-runtime/bin/node --experimental-strip-types tools/configure-ubuntu.mjs --port 18787 --listen-host 127.0.0.1 --viewer-mode loopback --public-origin http://127.0.0.1:18787
sha=$(git rev-parse HEAD)
/home/tma/node-runtime/bin/node --experimental-strip-types tools/publish-ubuntu.mjs --apply --architecture amd64 --target-sha "$sha"
systemctl --user is-enabled tma-analytics.service
systemctl --user is-active tma-analytics.service
if [ "$(systemctl --user is-enabled tma-update.service)" != static ]; then
  echo 'update oneshot must remain static after provisioning' >&2
  exit 1
fi
test -x /var/lib/tma-deploy/updater/node-runtime/bin/node
test -x /var/lib/tma-deploy/updater/node-runtime/bin/npm
test -x /home/tma/.local/bin/mise
PATH=/var/lib/tma-deploy/updater/node-runtime/bin:/home/tma/.local/bin:/usr/bin:/bin npm --version
systemctl --user cat tma-update.service | grep -F 'Environment=PATH=/var/lib/tma-deploy/updater/node-runtime/bin:%h/.local/bin:'
curl --connect-timeout 5 --max-time 30 --fail --silent --show-error http://127.0.0.1:18787/api/health | tee /tmp/tma-health-before.json
test -s /var/lib/tma-analytics/analytics.db
test -f /var/lib/tma-analytics/hub-secrets.json
EOF
guest 'systemctl --user status --no-pager tma-analytics.service' | tee "$artifact_dir/service-before-reboot.txt"
guest 'cat /tmp/tma-health-before.json' | tee "$artifact_dir/health-before-reboot.json"

echo 'Running the real user-systemd one-shot update against an isolated local Git fixture'
guest_update <<'EOF'
set -Eeuo pipefail
export PATH=/home/tma/node-runtime/bin:/home/tma/.local/bin:$PATH
cd /home/tma/repo
git config user.name 'TMA acceptance fixture'
git config user.email 'tma-acceptance@example.invalid'
git checkout -B main
rm -rf /var/lib/tma-deploy/acceptance-remote.git
git init --bare --quiet /var/lib/tma-deploy/acceptance-remote.git
git remote remove acceptance 2>/dev/null || true
git remote add acceptance /var/lib/tma-deploy/acceptance-remote.git
git push --quiet acceptance HEAD:refs/heads/main
printf '\n/* isolated acceptance release payload */\n' >> analytics/public/styles.css
git add analytics/public/styles.css
git commit --quiet -m 'isolated acceptance candidate payload'
git push --quiet acceptance HEAD:refs/heads/main
candidate=$(git rev-parse HEAD)
printf '%s\n' "$candidate" > /tmp/tma-update-candidate.sha

# The production runner validates an HTTPS origin. A guest-only system Git
# rewrite keeps it intact. Both config and bare repository remain visible to
# the Analytics unit with ProtectHome=true; no application code is modified.
sudo git config --system url."file:///var/lib/tma-deploy/acceptance-remote.git".insteadOf https://acceptance.invalid/tma.git

/home/tma/node-runtime/bin/node --input-type=module - <<'NODE'
import fs from 'node:fs';
const filename='/var/lib/tma-deploy/config/analytics.json';
const config=JSON.parse(fs.readFileSync(filename,'utf8'));
config.update={...(config.update??{}),enabled:true,repositoryUrl:'https://acceptance.invalid/tma.git',branch:'main',checkIntervalSeconds:3600};
fs.writeFileSync(filename,`${JSON.stringify(config,null,2)}\n`,{mode:0o600});
NODE

sha256sum /var/lib/tma-deploy/config/analytics.json | awk '{print $1}' > /home/tma/config-before-update.sha
sha256sum /var/lib/tma-analytics/hub-secrets.json | awk '{print $1}' > /home/tma/secret-before-update.sha
systemctl --user stop tma-analytics.service
/home/tma/node-runtime/bin/node --input-type=module - <<'NODE'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const filename='/var/lib/tma-analytics/analytics.db';
const marker='tma-acceptance-persistent-marker-v1';
const db=new DatabaseSync(filename);
try {
 db.exec('PRAGMA busy_timeout=5000');
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('database integrity check failed before update');
 db.prepare("INSERT INTO app_metadata(key,value) VALUES('acceptance_marker',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(marker);
 const row=db.prepare("SELECT value FROM app_metadata WHERE key='acceptance_marker'").get();
 if(row?.value!==marker)throw new Error('database marker did not commit before update');
 fs.writeFileSync('/tmp/tma-db-before-update.json',JSON.stringify({marker,appMetadataRows:Number(db.prepare('SELECT COUNT(*) AS count FROM app_metadata').get().count),schemaMigrations:Number(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count),integrity:'ok'},null,2)+'\n',{mode:0o600});
} finally { db.close(); }
NODE
systemctl --user start tma-analytics.service
for attempt in $(seq 1 60); do
  if curl --connect-timeout 5 --max-time 30 --fail --silent http://127.0.0.1:18787/api/health >/tmp/tma-health-update-start.json; then break; fi
  if ((attempt == 60)); then echo 'Analytics did not restart before update acceptance' >&2; exit 1; fi
  sleep 1
done
main_pid_before=$(systemctl --user show -p MainPID --value tma-analytics.service)
if ! [[ "$main_pid_before" =~ ^[1-9][0-9]*$ ]]; then echo "invalid Analytics MainPID before update: $main_pid_before" >&2; exit 1; fi
printf '%s\n' "$main_pid_before" > /tmp/tma-main-pid-before-update

/home/tma/node-runtime/bin/node --input-type=module - <<'NODE'
import fs from 'node:fs';
const base='http://127.0.0.1:18787';
const fetchWithTimeout=(url,options={},timeoutMs=30000)=>fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});
async function request(route,body){
 const response=await fetchWithTimeout(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await response.json();
 if(!response.ok)throw new Error(`${route} failed: ${response.status} ${JSON.stringify(data)}`);
 return data;
}
const checked=await request('/api/manage/update/check',{});
const candidate=checked.candidate;
if(!candidate?.hasUpdate||!/^[0-9a-f]{40}$/.test(candidate.targetCommitSha))throw new Error('local update candidate was not accepted');
const applied=await request('/api/manage/update/apply',{targetCommitSha:candidate.targetCommitSha});
if(!applied.jobId)throw new Error('update apply did not return a job ID');
fs.writeFileSync('/tmp/tma-update-request.json',JSON.stringify({jobId:applied.jobId,targetCommitSha:candidate.targetCommitSha},null,2)+'\n',{mode:0o600});
NODE

for attempt in $(seq 1 300); do
  date --iso-8601=seconds >> /tmp/tma-update-service-trace.txt
  systemctl --user show -p ActiveState -p SubState -p MainPID tma-update.service >> /tmp/tma-update-service-trace.txt
  if grep -q '"status": "completed"' /var/lib/tma-deploy/update-state.json; then break; fi
  if grep -q '"status": "failed"\|"status": "aborted"' /var/lib/tma-deploy/update-state.json; then
    cat /var/lib/tma-deploy/update-state.json >&2
    tail -60 /tmp/tma-update-service-trace.txt >&2
    journalctl --user -u tma-analytics.service -u tma-update.service --no-pager -n 250 >&2 || true
    exit 1
  fi
  if ((attempt == 300)); then echo 'Timed out waiting for the isolated update oneshot' >&2; cat /var/lib/tma-deploy/update-state.json >&2; exit 1; fi
  sleep 2
done

/home/tma/node-runtime/bin/node --input-type=module - <<'NODE'
import fs from 'node:fs';
const request=JSON.parse(fs.readFileSync('/tmp/tma-update-request.json','utf8'));
const state=JSON.parse(fs.readFileSync('/var/lib/tma-deploy/update-state.json','utf8'));
if(state.jobId!==request.jobId||state.targetCommitSha!==request.targetCommitSha||state.status!=='completed'||state.stage!=='success')throw new Error('update state did not retain the accepted terminal job');
const fetchWithTimeout=(url,options={},timeoutMs=30000)=>fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});
const health=await (await fetchWithTimeout('http://127.0.0.1:18787/api/health')).json();
if(health.release?.targetCommitSha!==request.targetCommitSha)throw new Error('Analytics did not restart at the candidate commit');
const sseController=new AbortController();const sseTimer=setTimeout(()=>sseController.abort(),10000);let reader;
let text='';
try {
 const sse=await fetch('http://127.0.0.1:18787/api/live',{signal:sseController.signal});
 if(sse.status!==200||!sse.body)throw new Error('Analytics SSE did not reopen after update');
 reader=sse.body.getReader();
 while(!text.includes('event: ready')){const next=await reader.read();if(next.done)break;text+=new TextDecoder().decode(next.value);}
} finally {
 try { await reader?.cancel(); } catch {}
 clearTimeout(sseTimer);sseController.abort();
}
if(!text.includes('event: ready'))throw new Error('Analytics SSE did not emit ready after update');
const history=await fetchWithTimeout('http://127.0.0.1:18787/api/usage-history/hubs');
if(history.status!==200)throw new Error('History API did not reopen after update');
NODE

test "$(cat /home/tma/config-before-update.sha)" = "$(sha256sum /var/lib/tma-deploy/config/analytics.json | awk '{print $1}')"
test "$(cat /home/tma/secret-before-update.sha)" = "$(sha256sum /var/lib/tma-analytics/hub-secrets.json | awk '{print $1}')"
main_pid_after=$(systemctl --user show -p MainPID --value tma-analytics.service)
if ! [[ "$main_pid_after" =~ ^[1-9][0-9]*$ ]] || [[ "$main_pid_before" == "$main_pid_after" ]]; then
  echo "Analytics MainPID did not change across the release update: before=$main_pid_before after=$main_pid_after" >&2
  exit 1
fi
printf '%s\n' "$main_pid_after" > /tmp/tma-main-pid-after-update
/home/tma/node-runtime/bin/node --input-type=module - <<'NODE'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const filename='/var/lib/tma-analytics/analytics.db';
const expected='tma-acceptance-persistent-marker-v1';
const db=new DatabaseSync(filename,{readOnly:true});
try {
 const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
 const marker=db.prepare("SELECT value FROM app_metadata WHERE key='acceptance_marker'").get()?.value;
 if(integrity!=='ok'||marker!==expected)throw new Error(`persistent database evidence failed: integrity=${integrity} marker=${marker}`);
 fs.writeFileSync('/tmp/tma-db-after-update.json',JSON.stringify({marker,appMetadataRows:Number(db.prepare('SELECT COUNT(*) AS count FROM app_metadata').get().count),schemaMigrations:Number(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count),integrity},null,2)+'\n',{mode:0o600});
} finally { db.close(); }
NODE
if [ "$(systemctl --user is-enabled tma-update.service)" != static ]; then
  echo 'update oneshot must remain static after an on-demand run' >&2
  exit 1
fi
curl --connect-timeout 5 --max-time 30 --fail --silent --show-error http://127.0.0.1:18787/api/health > /tmp/tma-health-after-update.json
EOF
guest 'cat /tmp/tma-update-request.json' | tee "$artifact_dir/update-request.json"
guest 'cat /tmp/tma-update-candidate.sha' | tee "$artifact_dir/update-candidate.sha"
guest 'cat /var/lib/tma-deploy/update-state.json' | tee "$artifact_dir/update-state.json"
guest 'cat /tmp/tma-health-update-start.json' | tee "$artifact_dir/health-update-start.json"
guest 'cat /tmp/tma-health-after-update.json' | tee "$artifact_dir/health-after-update.json"
guest 'cat /tmp/tma-db-before-update.json' | tee "$artifact_dir/db-before-update.json"
guest 'cat /tmp/tma-db-after-update.json' | tee "$artifact_dir/db-after-update.json"
guest 'printf "before="; cat /tmp/tma-main-pid-before-update; printf "after="; cat /tmp/tma-main-pid-after-update' | tee "$artifact_dir/main-pid-update.txt"

boot_before=$(guest 'cat /proc/sys/kernel/random/boot_id')
printf '%s\n' "$boot_before" > "$artifact_dir/boot-before.txt"

echo 'Rebooting the guest (the host and its production services are untouched)'
guest 'sudo systemctl reboot' >/dev/null 2>&1 || true
sleep 4
reboot_down_deadline=$((SECONDS + 120))
while ((SECONDS < reboot_down_deadline)); do
  if ! guest true >/dev/null 2>&1; then break; fi
  sleep 1
done
if guest true >/dev/null 2>&1; then echo 'Guest SSH did not stop during reboot' >&2; exit 1; fi
reboot_ssh_deadline=$((SECONDS + 600))
reboot_ssh_ready=false
while ((SECONDS < reboot_ssh_deadline)); do
  if ! kill -0 "$vm_pid" 2>/dev/null; then echo 'QEMU exited during guest reboot' >&2; exit 1; fi
  if guest true >/dev/null 2>&1; then reboot_ssh_ready=true; break; fi
  sleep 2
done
if [[ "$reboot_ssh_ready" != true ]]; then echo 'Timed out waiting for SSH after guest reboot' >&2; exit 1; fi

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
if [ "$(systemctl --user is-enabled tma-update.service)" != static ]; then
  echo 'update oneshot unexpectedly enabled after reboot' >&2
  exit 1
fi
curl --connect-timeout 5 --max-time 30 --fail --silent --show-error http://127.0.0.1:18787/api/health | tee /tmp/tma-health-after.json
test -s /var/lib/tma-analytics/analytics.db
test -f /var/lib/tma-analytics/hub-secrets.json
systemctl --user status --no-pager tma-analytics.service
test "$(cat /home/tma/config-before-update.sha)" = "$(sha256sum /var/lib/tma-deploy/config/analytics.json | awk '{print $1}')"
test "$(cat /home/tma/secret-before-update.sha)" = "$(sha256sum /var/lib/tma-analytics/hub-secrets.json | awk '{print $1}')"
/home/tma/node-runtime/bin/node --input-type=module - <<'NODE'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/var/lib/tma-analytics/analytics.db',{readOnly:true});
try {
 const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
 const marker=db.prepare("SELECT value FROM app_metadata WHERE key='acceptance_marker'").get()?.value;
 if(integrity!=='ok'||marker!=='tma-acceptance-persistent-marker-v1')throw new Error(`persistent database evidence failed after reboot: integrity=${integrity} marker=${marker}`);
 fs.writeFileSync('/tmp/tma-db-after-reboot.json',JSON.stringify({marker,appMetadataRows:Number(db.prepare('SELECT COUNT(*) AS count FROM app_metadata').get().count),schemaMigrations:Number(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count),integrity},null,2)+'\n',{mode:0o600});
} finally { db.close(); }
NODE
EOF
guest 'cat /tmp/tma-health-after.json' | tee "$artifact_dir/health-after-reboot.json"
guest 'cat /tmp/tma-db-after-reboot.json' | tee "$artifact_dir/db-after-reboot.json"
echo 'PASS: isolated Ubuntu user service survived an actual guest reboot'
