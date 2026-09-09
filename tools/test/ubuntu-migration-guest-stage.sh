#!/usr/bin/env bash
set -Eeuo pipefail

# This file is copied into the disposable Ubuntu guest by ubuntu-reboot-vm.sh.
# It exercises the production migration CLI and its default Linux platform
# hooks. The only synthetic process is the Collector unit: the pinned legacy
# source is used for the real Analytics server and reset-hubs HTTP drain, while
# an idle process gives systemd a real old Collector PID to stop/inhibit.
# Building the historical Go Collector would add an unrelated compiler and
# network dependency without changing the migration boundary being tested.

repo_root=${1:?repository root is required}
node_bin=${2:?fixed Node binary is required}
target_artifact=${3:?target release artifact is required}
target_checksum=${4:?target release checksum is required}
evidence_dir=${5:?evidence directory is required}

legacy_sha='cae687c4947990e9da6db3193ea8afe26b4b5246'
old_config_dir='/etc/token-monitor-analytics'
old_analytics_config="$old_config_dir/analytics.json"
old_collector_config="$old_config_dir/collector.json"
old_analytics_env="$old_config_dir/analytics.env"
old_collector_env="$old_config_dir/collector.env"
old_hubs="$old_config_dir/hubs.json"
old_hub_secrets="$old_config_dir/hub-secrets.json"
old_database='/var/lib/tma-analytics/analytics.db'
old_outbox='/var/lib/tma-collector/outbox'
old_release='/opt/token-monitor-analytics/releases/legacy-pinned'
old_current='/opt/token-monitor-analytics/current'
old_runner='/var/lib/tma-deploy/updater'
old_fixed_node="$old_runner/node"
old_infrastructure='/etc/token-monitor-analytics/infrastructure.json'
old_publication='/opt/token-monitor-analytics/publication.json'
old_update_state='/var/lib/tma-deploy/update-state.json'
old_user_units='/home/tma/.config/systemd/user'
state_path='/var/lib/tma-deploy/migration-state.json'
backup_dir='/var/lib/tma-deploy/migration-backup'
target_config='/var/lib/tma-deploy/config/analytics.json'
target_secrets='/var/lib/tma-deploy/config/hub-secrets.json'
target_env='/var/lib/tma-deploy/config/analytics.env'
lock_path='/var/lib/tma-lock/deploy.lock'
legacy_source='/home/tma/legacy-source'
legacy_archive='/home/tma/legacy-source.tar'
legacy_manifest='/home/tma/legacy-source-manifest.json'
old_port=18887
target_port=18787
ingest_token='legacy-ingest-token-ubuntu-acceptance-000000000000000000000000000000'
hub_secret='legacy-hub-secret-ubuntu-acceptance-0000000000000000000000000000'

export PATH="$(dirname "$node_bin"):/home/tma/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
repo_root=$(cd "$repo_root" && pwd)
node_bin=$(readlink -f "$node_bin")
target_artifact=$(readlink -f "$target_artifact")
target_checksum=$(readlink -f "$target_checksum")
evidence_dir=$(readlink -m "$evidence_dir")
mkdir -p "$evidence_dir"
exec > >(tee "$evidence_dir/stage.log") 2>&1

fail() { echo "FAIL: $*" >&2; exit 1; }
require_file() { [[ -f "$1" && ! -L "$1" ]] || fail "regular file required: $1"; }
userctl() {
  XDG_RUNTIME_DIR=/run/user/$(id -u tma) \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u tma)/bus \
    systemctl --user "$@"
}
root_node() {
  sudo env PATH="$PATH" TMA_DEPLOY_USER=tma "$node_bin" --experimental-strip-types "$@"
}

require_file "$target_artifact"
require_file "$target_checksum"
[[ -x "$node_bin" ]] || fail "fixed Node is not executable: $node_bin"
[[ -d "$repo_root/.git" ]] || fail "repository is not a Git checkout: $repo_root"
target_sha=$(git -C "$repo_root" rev-parse HEAD)
[[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] || fail "target checkout is not pinned to a full SHA"
git -C "$repo_root" cat-file -e "$legacy_sha^{commit}"
git -C "$repo_root" diff --exit-code
git -C "$repo_root" diff --cached --exit-code
(
  cd "$(dirname "$target_artifact")"
  sha256sum --check "$(basename "$target_checksum")"
)
printf '%s\n' "$target_sha" > "$evidence_dir/target-sha.txt"
printf '%s\n' "$legacy_sha" > "$evidence_dir/legacy-sha.txt"

echo 'Preparing the pinned legacy source archive from the clean checkout'
rm -rf "$legacy_source" "$legacy_archive" "$legacy_manifest"
mkdir -m 0755 "$legacy_source"
"$node_bin" --experimental-strip-types "$repo_root/tools/migration-source.mjs" \
  --repository "$repo_root" \
  --output "$legacy_source" \
  --archive "$legacy_archive" \
  --manifest "$legacy_manifest" | tee "$evidence_dir/legacy-source-preparation.json"
require_file "$legacy_manifest"
cp -f "$legacy_manifest" "$evidence_dir/legacy-source-manifest.json"

echo 'Creating the old user-service installation in the disposable guest'
# Every path below is inside the guest. The explicit removal keeps this stage
# repeatable and cannot affect the host because QEMU owns the guest disk.
sudo rm -rf -- \
  /etc/token-monitor-analytics \
  /opt/token-monitor-analytics \
  /var/lib/tma-analytics \
  /var/lib/tma-collector \
  /var/lib/tma-deploy \
  /var/lib/tma-lock
sudo rm -rf -- "$old_user_units"
sudo install -d -o tma -g tma -m 0755 /opt/token-monitor-analytics/releases
sudo cp -a "$legacy_source/." "$old_release"
sudo chown -R tma:tma /opt/token-monitor-analytics
sudo ln -s "$old_release" "$old_current"
sudo chown -h tma:tma "$old_current"

sudo install -d -o root -g tma -m 0750 "$old_config_dir"
sudo install -d -o tma -g tma -m 0700 /var/lib/tma-analytics "$old_outbox"
sudo install -d -o tma -g tma -m 0700 "$old_runner"
sudo install -d -o tma -g tma -m 0700 /home/tma/.config/systemd/user

sudo install -o tma -g tma -m 0755 "$node_bin" "$old_fixed_node"
printf 'legacy-runner-marker-v1\n' | sudo tee "$old_runner/legacy-runner.marker" >/dev/null
sudo chown tma:tma "$old_runner/legacy-runner.marker"
sudo chmod 0600 "$old_runner/legacy-runner.marker"
printf '%s\n' '{"layout":"legacy-infrastructure-v1","owner":"root"}' | sudo tee "$old_infrastructure" >/dev/null
sudo chown root:root "$old_infrastructure"
sudo chmod 0644 "$old_infrastructure"
printf '%s\n' '{"release":"legacy-publication-v1"}' | sudo tee "$old_publication" >/dev/null
sudo chown tma:tma "$old_publication"
sudo chmod 0600 "$old_publication"
printf '%s\n' '{"status":"idle","release":"legacy-runner-v1"}' | sudo tee "$old_update_state" >/dev/null
sudo chown tma:tma "$old_update_state"
sudo chmod 0600 "$old_update_state"

root_node --input-type=module - "$old_analytics_config" "$old_collector_config" "$old_analytics_env" "$old_collector_env" "$old_hubs" "$old_hub_secrets" "$old_database" "$old_outbox" "$ingest_token" "$hub_secret" "$old_port" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [analyticsFile,collectorFile,analyticsEnv,collectorEnv,hubsFile,secretsFile,databasePath,outboxPath,token,hubSecret,portText]=process.argv.slice(2);
const port=Number(portText);
const contract={id:'legacy-contract',label:'Legacy Contract',hubId:'legacy-hub',provider:'legacy-provider',accountKey:'legacy-account',clientIds:['legacy-client'],deviceIds:['legacy-device'],windowKind:'hour',windowHours:1,monthlyFeeUsd:10,attributionConfirmed:true,minDeltaPercent:1,maxSourceSkewSeconds:120,maxGapSeconds:120};
const hubs={schemaVersion:1,revision:0,secretsPath:'hub-secrets.json',hubs:[{id:'legacy-hub',label:'Legacy Hub',url:'https://legacy.example.invalid',status:'active',secretRef:'legacy-hub'}]};
const secrets={schemaVersion:1,secrets:{'legacy-hub':hubSecret}};
const analytics={version:1,listen:{host:'127.0.0.1',port},publicOrigin:`http://127.0.0.1:${port}`,databasePath,timeZone:'UTC',detailRetentionDays:30,ingestTokenEnv:'TMA_LEGACY_INGEST_TOKEN',viewerAuth:{mode:'loopback'},hubsPath:'hubs.json',contracts:[contract],update:{enabled:false},demo:false};
const collector={version:1,analytics_url:`http://127.0.0.1:${port}`,ingest_token_env:'TMA_LEGACY_INGEST_TOKEN',spool_dir:outboxPath,max_spool_bytes:1024*1024,flush_seconds:2,batch_size:2,idle_seconds:90,hubs:[{id:'legacy-hub',url:'https://legacy.example.invalid',secret_env:'OLD_HUB_SECRET'}]};
const write=(file,value,mode=0o640)=>{fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`,{mode});fs.chmodSync(file,mode);};
write(analyticsFile,analytics);write(collectorFile,collector);write(hubsFile,hubs);write(secretsFile,secrets);
fs.writeFileSync(analyticsEnv,`TMA_LEGACY_INGEST_TOKEN=${token}\nLEGACY_ANALYTICS_MARKER=preserve-analytics-env-v1\n`,{mode:0o640});
fs.writeFileSync(collectorEnv,`TMA_LEGACY_INGEST_TOKEN=${token}\nOLD_HUB_SECRET=${hubSecret}\nLEGACY_COLLECTOR_MARKER=preserve-collector-env-v1\n`,{mode:0o640});
fs.mkdirSync(path.dirname(databasePath),{recursive:true,mode:0o700});
fs.closeSync(fs.openSync(databasePath,'w',{mode:0o600}));fs.chmodSync(databasePath,0o600);
fs.mkdirSync(outboxPath,{recursive:true,mode:0o700});
NODE
sudo chown root:tma "$old_analytics_config" "$old_collector_config" "$old_analytics_env" "$old_collector_env" "$old_hubs" "$old_hub_secrets"
sudo chmod 0640 "$old_analytics_config" "$old_collector_config" "$old_analytics_env" "$old_collector_env" "$old_hubs" "$old_hub_secrets"
sudo chown tma:tma "$old_database" "$old_outbox"
sudo chmod 0600 "$old_database"

cat > /tmp/tma-old-analytics.service <<EOF
[Unit]
Description=Legacy Token Monitor Analytics (pinned source)
After=network.target

[Service]
Type=simple
WorkingDirectory=$old_current/analytics
Environment=NODE_ENV=production
EnvironmentFile=$old_analytics_env
ExecStart=$old_fixed_node --experimental-strip-types $old_current/analytics/runtime/server.mjs --config $old_analytics_config
ExecStopPost=/usr/bin/touch /home/tma/migration-evidence/legacy-analytics-stop-seen
Restart=on-failure
RestartSec=1
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
EOF
cat > /tmp/tma-old-collector.service <<EOF
[Unit]
Description=Legacy Collector idle service fixture (real systemd control)
After=network.target tma-analytics.service

[Service]
Type=simple
EnvironmentFile=$old_collector_env
ExecStart=/usr/bin/tail -f /dev/null
ExecStopPost=/usr/bin/touch /home/tma/migration-evidence/legacy-collector-stop-seen
Restart=on-failure
RestartSec=1
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
EOF
cat > /tmp/tma-old-update.service <<'EOF'
[Unit]
Description=Legacy update placeholder (disabled)

[Service]
Type=oneshot
ExecStart=/usr/bin/true

[Install]
WantedBy=default.target
EOF
sudo install -o tma -g tma -m 0644 /tmp/tma-old-analytics.service "$old_user_units/tma-analytics.service"
sudo install -o tma -g tma -m 0644 /tmp/tma-old-collector.service "$old_user_units/tma-collector.service"
sudo install -o tma -g tma -m 0644 /tmp/tma-old-update.service "$old_user_units/tma-update.service"

uid=$(id -u tma)
sudo loginctl enable-linger tma
sudo systemctl start "user@${uid}.service"
userctl daemon-reload
userctl unmask tma-analytics.service tma-collector.service tma-update.service || true
userctl enable tma-analytics.service tma-collector.service
userctl disable tma-update.service || true
userctl start tma-analytics.service
userctl start tma-collector.service

echo 'Waiting for the real pinned legacy Analytics service'
for attempt in $(seq 1 90); do
  if curl --connect-timeout 2 --max-time 5 --fail --silent "http://127.0.0.1:${old_port}/api/health" >/tmp/tma-legacy-health-before.json; then break; fi
  if ((attempt == 90)); then
    userctl status --no-pager tma-analytics.service || true
    fail 'pinned legacy Analytics did not become healthy'
  fi
  sleep 1
done

root_node --input-type=module - "$old_outbox" <<'NODE'
import fs from 'node:fs';
const outbox=process.argv[2];
const times=['2026-09-09T00:00:00.000Z','2026-09-09T00:01:00.000Z','2026-09-09T00:02:00.000Z'];
for(const [index,at] of times.entries()){
 const eventId=`${String.fromCharCode(97+index)}${'0'.repeat(31)}`;
 const event={schemaVersion:1,eventId,hubId:'legacy-hub',streamId:'c'.repeat(32),kind:'snapshot',observedAt:at,receivedAt:new Date(Date.parse(at)+1000).toISOString(),stats:{updatedAt:at,periods:{today:{costUsd:1,totalTokens:10},allTime:{costUsd:1,totalTokens:10}},devices:[{deviceId:'legacy-device',updatedAt:at,stale:false,periods:{allTime:{costUsd:1,totalTokens:10,clientCosts:{'legacy-client':1}}}}],limits:{providers:[{provider:'legacy-provider',accountKey:'legacy-account',updatedAt:at,status:'ok',stale:false,windows:[{kind:'hour',usedPercent:1,resetsAt:'2026-09-09T02:00:00.000Z'}]}]}}};
 fs.writeFileSync(`${outbox}/${String(index+1).padStart(4,'0')}-${eventId}.json`,`${JSON.stringify(event)}\n`,{mode:0o600});
}
NODE
sudo chown tma:tma "$old_outbox"/*.json
sudo chmod 0600 "$old_outbox"/*.json

record_layout() {
  local output=$1
  root_node --input-type=module - "$output" "$old_analytics_config" "$old_collector_config" "$old_analytics_env" "$old_collector_env" "$old_hubs" "$old_hub_secrets" "$old_release" "$old_current" "$old_runner" "$old_infrastructure" "$old_publication" "$old_update_state" "$old_user_units" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [output,...roots]=process.argv.slice(2);
const sensitive=new Set(['analytics.env','collector.env','hub-secrets.json']);
const entries=[];
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const visit=(filename)=>{
 const stat=fs.lstatSync(filename);
 const entry={path:filename,type:stat.isDirectory()?'directory':stat.isFile()?'file':stat.isSymbolicLink()?'symlink':'other',uid:stat.uid,gid:stat.gid,mode:stat.mode&0o7777,size:stat.size};
 if(stat.isSymbolicLink())entry.link=fs.readlinkSync(filename);
 if(stat.isFile()&&!sensitive.has(path.basename(filename)))entry.sha256=digest(filename);
 entries.push(entry);
 if(stat.isDirectory()&&!stat.isSymbolicLink())for(const name of fs.readdirSync(filename).sort())visit(path.join(filename,name));
};
for(const root of roots)if(fs.existsSync(root))visit(root);else throw new Error(`legacy layout entry is missing: ${root}`);
entries.sort((a,b)=>a.path.localeCompare(b.path));
fs.writeFileSync(output,JSON.stringify({schemaVersion:1,entries},null,2)+'\n',{mode:0o600});
NODE
}

record_layout "$evidence_dir/legacy-layout-before.json"
root_node --input-type=module - "$evidence_dir/database-before.json" "$old_database" <<'NODE'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const [output,filename]=process.argv.slice(2);
const db=new DatabaseSync(filename,{readOnly:true});
try {
 const integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check;
 const migrations=Number(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n??0);
 const observations=Number(db.prepare('SELECT count(*) AS n FROM observations').get()?.n??0);
 fs.writeFileSync(output,JSON.stringify({schemaVersion:1,integrity,migrations,observations},null,2)+'\n',{mode:0o600});
} finally { db.close(); }
NODE
printf '%s\n' "$old_port" > "$evidence_dir/legacy-port.txt"
curl --fail --silent "http://127.0.0.1:$old_port/api/health" > "$evidence_dir/legacy-health-before.json"
userctl status --no-pager tma-analytics.service > "$evidence_dir/legacy-analytics-before.txt"
userctl status --no-pager tma-collector.service > "$evidence_dir/legacy-collector-before.txt"
userctl is-enabled tma-analytics.service > "$evidence_dir/legacy-analytics-enabled-before.txt"
userctl is-enabled tma-collector.service > "$evidence_dir/legacy-collector-enabled-before.txt"
if userctl is-enabled --quiet tma-update.service; then fail 'old update unit unexpectedly enabled'; fi
userctl is-active tma-analytics.service
userctl is-active tma-collector.service
find "$old_outbox" -maxdepth 1 -type f -printf '%f\n' | sort > "$evidence_dir/outbox-before.txt"
rm -f "$evidence_dir/legacy-analytics-stop-seen" "$evidence_dir/legacy-collector-stop-seen"

echo 'Running the production migration CLI with its real Ubuntu platform hooks'
sudo env -u TMA_MIGRATION_REAL -u TMA_MIGRATION_LEGACY_SOURCE_MANIFEST \
  PATH="$PATH" TMA_DEPLOY_USER=tma \
  "$node_bin" --experimental-strip-types "$repo_root/tools/migrate.mjs" \
  --old-sha "$legacy_sha" \
  --target-sha "$target_sha" \
  --target-artifact "$target_artifact" \
  --analytics-config "$old_analytics_config" \
  --collector-config "$old_collector_config" \
  --analytics-env "$old_analytics_env" \
  --collector-env "$old_collector_env" \
  --state "$state_path" \
  --backup-dir "$backup_dir" \
  --target-config "$target_config" \
  --target-secrets "$target_secrets" \
  --target-analytics-env "$target_env" \
  --target-host 127.0.0.1 \
  --target-port "$target_port" \
  --target-origin "http://127.0.0.1:$target_port" \
  --target-viewer-mode loopback \
  --publication-user tma \
  --publication-home /home/tma \
  --legacy-code-root "$old_current" \
  --current-dir "$old_current" \
  --legacy-runner-dir "$old_runner" \
  --legacy-node-path "$old_fixed_node" \
  --infrastructure-path "$old_infrastructure" \
  --publication-path "$old_publication" \
  --update-state-path "$old_update_state" \
  --repository "$repo_root" \
  --lock "$lock_path" | tee "$evidence_dir/migration-result.json"

test -f "$evidence_dir/legacy-analytics-stop-seen"
test -f "$evidence_dir/legacy-collector-stop-seen"
test -s "$state_path"
cp -f "$state_path" "$evidence_dir/migration-state-complete.json"
userctl status --no-pager tma-analytics.service > "$evidence_dir/new-analytics-after-migration.txt"
userctl status --no-pager tma-collector.service > "$evidence_dir/old-collector-after-migration.txt" || true
userctl show -p ActiveState,SubState,UnitFileState,MainPID tma-analytics.service > "$evidence_dir/new-analytics-state.txt"
userctl show -p ActiveState,SubState,UnitFileState,MainPID tma-collector.service > "$evidence_dir/old-collector-state.txt"
userctl is-enabled tma-analytics.service
userctl is-active tma-analytics.service
collector_unit_state=$(userctl show -p UnitFileState --value tma-collector.service)
case "$collector_unit_state" in masked|disabled) ;; *) fail "legacy Collector was not inhibited: $collector_unit_state" ;; esac
if userctl is-active --quiet tma-collector.service; then fail 'legacy Collector remained active after migration'; fi
if userctl is-enabled --quiet tma-update.service; then fail 'update oneshot became enabled during migration'; fi

echo 'Checking the migrated native database, empty Hub registrations, and target service'
for attempt in $(seq 1 90); do
  if curl --connect-timeout 2 --max-time 5 --fail --silent "http://127.0.0.1:$target_port/api/health" > "$evidence_dir/new-health-after-migration.json"; then break; fi
  if ((attempt == 90)); then userctl status --no-pager tma-analytics.service || true; fail 'new Analytics did not become healthy'; fi
  sleep 1
done
root_node --input-type=module - "$evidence_dir/migration-database.json" "$old_database" "$target_config" "$target_secrets" <<'NODE'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const [output,database,configFile,secretsFile]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const secrets=JSON.parse(fs.readFileSync(secretsFile,'utf8'));
if(config.version!==2||config.contracts?.length!==0||config.ingestTokenEnv!==undefined||config.hubsPath!==undefined)throw new Error('target configuration still contains legacy registration');
if(JSON.stringify(secrets)!==JSON.stringify({schemaVersion:1,secrets:{}}))throw new Error('target Hub Secret store is not empty');
const db=new DatabaseSync(database,{readOnly:true});
try {
 const integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check;
 const migrations=Number(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n??0);
 const observations=Number(db.prepare('SELECT count(*) AS n FROM observations').get()?.n??0);
 const hub=db.prepare('SELECT id,label,url,secret_ref,status FROM hubs WHERE id=?').get('legacy-hub');
 const contract=db.prepare('SELECT contract_id,hub_id,definition_json FROM contract_snapshots WHERE contract_id=?').get('legacy-contract');
 const eventIds=db.prepare('SELECT event_id FROM observations ORDER BY event_id').all().map(row=>row.event_id);
 if(integrity!=='ok'||migrations!==4||observations!==3)throw new Error(`migrated DB evidence failed: ${integrity}/${migrations}/${observations}`);
 if(!hub||hub.status!=='archived'||hub.url!==null||hub.secret_ref!==null)throw new Error('legacy Hub was not archived without reconnect data');
 if(!contract||!String(contract.definition_json).includes('legacy-contract'))throw new Error('legacy contract snapshot is unreadable');
 if(eventIds.length!==3)throw new Error('ACKed observations were not preserved');
 fs.writeFileSync(output,JSON.stringify({integrity,migrations,observations,hub,contractId:contract.contract_id,eventIds},null,2)+'\n',{mode:0o600});
} finally { db.close(); }
NODE
test "$(find "$old_outbox" -maxdepth 1 -type f -name '*.json' | wc -l)" -eq 0
root_node --input-type=module - "$evidence_dir/new-http-after-migration.json" "$target_port" <<'NODE'
import fs from 'node:fs';
const [output,portText]=process.argv.slice(2);
const origin=`http://127.0.0.1:${portText}`;
const request=async route=>{const response=await fetch(origin+route,{signal:AbortSignal.timeout(15000)});const body=await response.json();if(!response.ok)throw new Error(`${route} returned ${response.status}`);return body;};
const health=await request('/api/health');const state=await request('/api/state');const history=await request('/api/usage-history/hubs');
const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);let text='';let reader;
try { const response=await fetch(origin+'/api/live',{signal:controller.signal});if(response.status!==200||!response.body)throw new Error('target SSE did not open');reader=response.body.getReader();while(!text.includes('event: ready')){const next=await reader.read();if(next.done)throw new Error('target SSE ended before ready');text+=new TextDecoder().decode(next.value);}}
finally {try{await reader?.cancel();}catch{}clearTimeout(timer);controller.abort();}
if(health.ok!==true||state.storage!=='sqlite'||history===undefined||!text.includes('event: ready'))throw new Error('target HTTP/SSE evidence failed');
fs.writeFileSync(output,JSON.stringify({health:true,stateStorage:state.storage,historyStatus:'ok',sseReady:true},null,2)+'\n',{mode:0o600});
NODE

echo 'Rolling back through the production restore CLI'
sudo env -u TMA_MIGRATION_REAL -u TMA_MIGRATION_LEGACY_SOURCE_MANIFEST \
  PATH="$PATH" TMA_DEPLOY_USER=tma \
  "$node_bin" --experimental-strip-types "$repo_root/tools/migrate.mjs" --restore \
  --state "$state_path" \
  --publication-user tma \
  --publication-home /home/tma \
  --current-dir "$old_current" \
  --legacy-code-root "$old_current" \
  --legacy-runner-dir "$old_runner" \
  --legacy-node-path "$old_fixed_node" \
  --infrastructure-path "$old_infrastructure" \
  --publication-path "$old_publication" \
  --update-state-path "$old_update_state" \
  --lock "$lock_path" | tee "$evidence_dir/restore-result.json"

cp -f "$state_path" "$evidence_dir/migration-state-restored.json"
userctl daemon-reload
userctl status --no-pager tma-analytics.service > "$evidence_dir/legacy-analytics-after-restore.txt"
userctl status --no-pager tma-collector.service > "$evidence_dir/legacy-collector-after-restore.txt"
userctl is-enabled tma-analytics.service
userctl is-enabled tma-collector.service
userctl is-active tma-analytics.service
userctl is-active tma-collector.service
if userctl is-enabled --quiet tma-update.service; then fail 'legacy update unit was enabled during rollback'; fi

for attempt in $(seq 1 90); do
  if curl --connect-timeout 2 --max-time 5 --fail --silent "http://127.0.0.1:$old_port/api/health" > "$evidence_dir/legacy-health-after-restore.json"; then break; fi
  if ((attempt == 90)); then userctl status --no-pager tma-analytics.service || true; fail 'restored legacy Analytics did not become healthy'; fi
  sleep 1
done

root_node --input-type=module - "$evidence_dir/legacy-layout-after.json" "$evidence_dir/legacy-layout-before.json" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [output,beforeFile]=process.argv.slice(2);
const before=JSON.parse(fs.readFileSync(beforeFile,'utf8'));
const sensitive=new Set(['analytics.env','collector.env','hub-secrets.json']);
const entries=[];
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const visit=filename=>{
 const stat=fs.lstatSync(filename);
 const entry={path:filename,type:stat.isDirectory()?'directory':stat.isFile()?'file':stat.isSymbolicLink()?'symlink':'other',uid:stat.uid,gid:stat.gid,mode:stat.mode&0o7777,size:stat.size};
 if(stat.isSymbolicLink())entry.link=fs.readlinkSync(filename);
 if(stat.isFile()&&!sensitive.has(path.basename(filename)))entry.sha256=digest(filename);
 entries.push(entry);
 if(stat.isDirectory()&&!stat.isSymbolicLink())for(const name of fs.readdirSync(filename).sort())visit(path.join(filename,name));
};
for(const item of before.entries){
 const root=item.path;
 if(!fs.existsSync(root))throw new Error(`restored legacy path is missing: ${root}`);
}
const roots=[...new Set(before.entries.map(item=>{
 let current=item.path;
 const marker='/';
 while(current!==marker&&before.entries.some(other=>other.path===path.dirname(current)))current=path.dirname(current);
 return current;
}))];
// Reconstruct only the top-level roots recorded before migration. This keeps
// generated target release directories outside the comparison.
for(const root of roots)visit(root);
entries.sort((a,b)=>a.path.localeCompare(b.path));
const after={schemaVersion:1,entries};
if(JSON.stringify(after)!==JSON.stringify(before))throw new Error('legacy code/config/runner/unit ownership or bytes were not restored exactly');
fs.writeFileSync(output,JSON.stringify(after,null,2)+'\n',{mode:0o600});
NODE

# Secret/environment files are intentionally excluded from the evidence
# manifest. Compare them only against the protected backup kept by the CLI.
for pair in \
  "$old_analytics_env:legacy-analytics-env" \
  "$old_collector_env:legacy-collector-env" \
  "$old_hub_secrets:legacy-hub-secrets"; do
  path_name=${pair%%:*}
  backup_name=${pair##*:}
  cmp -s "$path_name" "$backup_dir/protected/$backup_name" || fail "sensitive legacy file was not restored: $path_name"
done

test ! -e "$target_config"
test ! -e "$target_secrets"
test ! -e "$target_env"
test "$(find "$old_outbox" -maxdepth 1 -type f -name '*.json' | wc -l)" -eq 0
test "$(readlink "$old_current")" = "$old_release"
test "$(cat "$old_runner/legacy-runner.marker")" = 'legacy-runner-marker-v1'
test "$(cat "$old_infrastructure")" = '{"layout":"legacy-infrastructure-v1","owner":"root"}'
test "$(cat "$old_publication")" = '{"release":"legacy-publication-v1"}'
test "$(cat "$old_update_state")" = '{"status":"idle","release":"legacy-runner-v1"}'

root_node --input-type=module - "$evidence_dir/legacy-database-after-restore.json" "$old_database" "$old_analytics_config" <<'NODE'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const [output,database,configFile]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
if(config.version!==1||config.contracts?.length!==1||config.contracts[0]?.id!=='legacy-contract')throw new Error('legacy contract configuration was not restored');
const db=new DatabaseSync(database,{readOnly:true});
try {
 const integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check;
 const migrations=Number(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n??0);
 const observations=Number(db.prepare('SELECT count(*) AS n FROM observations').get()?.n??0);
 const eventIds=db.prepare('SELECT event_id FROM observations ORDER BY event_id').all().map(row=>row.event_id);
 if(integrity!=='ok'||migrations!==1||observations!==3||eventIds.length!==3)throw new Error(`restored legacy DB evidence failed: ${integrity}/${migrations}/${observations}`);
 fs.writeFileSync(output,JSON.stringify({integrity,migrations,observations,eventIds,contractId:config.contracts[0].id},null,2)+'\n',{mode:0o600});
} finally { db.close(); }
NODE

root_node --input-type=module - "$evidence_dir/post-cutover-backup.json" "$state_path" <<'NODE'
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const [output,stateFile]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
if(state.status!=='restored'||state.phase!=='complete'||state.restore?.legacyStarted!==true)throw new Error('restore state did not reach the explicit restored terminal status');
const filename=state.restore?.postCutoverPreserved;
if(typeof filename!=='string'||!fs.statSync(filename).isFile())throw new Error('post-cutover database was not preserved before rollback');
const db=new DatabaseSync(filename,{readOnly:true});
try {
 const integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check;
 const migrations=Number(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n??0);
 const hub=db.prepare('SELECT status,url,secret_ref FROM hubs WHERE id=?').get('legacy-hub');
 if(integrity!=='ok'||migrations!==4||!hub||hub.status!=='archived'||hub.url!==null||hub.secret_ref!==null)throw new Error('preserved cutover database is not the migrated native database');
 fs.writeFileSync(output,JSON.stringify({integrity,migrations,archivedHub:true},null,2)+'\n',{mode:0o600});
} finally { db.close(); }
NODE

cp -f "$evidence_dir/legacy-layout-before.json" "$evidence_dir/legacy-layout-restored.json"
echo 'PASS: real Ubuntu migration, archive, native publish, rollback, and old-service ownership restore'
