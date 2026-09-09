# Acceptance preparation matrix for #28

Status: prepared 2026-09-09 from commit `eec3217` on branch
`codex/acceptance-28`. This is an evidence plan and bounded Windows CI fix;
it does not certify the release while #27 is still in progress.

## Evidence rules

`PASS` means that the check executed successfully on the recorded final SHA
and has a retained log or artifact. `COVERED` means that a focused test exists
in the source but this matrix has no final-SHA execution artifact yet.
`PARTIAL` means that the check executed but an OS, package, or process boundary
is still missing. `GAP` means that the requirement needs a new test or an
actual environment run. A skipped test is evidence that the prerequisite was
absent, not a pass. The existing host is Ubuntu 24.04; its old production
services and database are active and must not be stopped, reconfigured, or
rebooted.

The current baseline artifacts are:

| Artifact | What it proves | Limit |
| --- | --- | --- |
| `/tmp/tma-orchestration/performance-preflight.md` | 256 devices × 370 daily rows (94,720 rows); JSON 5,835,423 bytes; parse/normalize 265.6 ms; one synchronous SQLite transaction 3,491.6 ms; one-device 365-day read 8.2 ms | Preliminary fixture only; it does not exercise the 16 MiB HTTP boundary, concurrent HTTP latency, or shutdown |
| `/tmp/tma-orchestration/windows-eec.log` | Windows Server 2025 reached the checkout path containing spaces and ran the native checks | The run has a secret ACL mode failure, a fixed-Node path failure, and an unrelated #26 update integration failure |
| `/tmp/tma-orchestration/docs/VERIFICATION.md` | Earlier Ubuntu/user-service and test observations | It explicitly records Windows, reboot, full Tailscale, and fresh end-to-end self-update as unexecuted; its old Collector wording must be refreshed after #27/#28 |
| `tools/integration*.mjs` | Node-only HTTP/SSE/SQLite integration fixtures; the main fixture uses a Git archive | They do not prove an actual systemd manager, reboot, or Tailscale interface |

## #19 requirement-to-evidence matrix

The rows below map every numbered #19 acceptance sentence to the focused
tests and to the missing evidence that #28 must close. Source paths are
relative to the repository root.

| #19 row | Existing evidence | Status | Missing acceptance evidence / owner |
| ---: | --- | :---: | --- |
| 1 | `analytics/test/native.test.mjs` covers new empty DB/secret configuration, `analytics/test/hubs.test.mjs` covers SQLite Hub registration, `analytics/test/viewer-history.test.mjs` covers one listener and state/history routes | PARTIAL | After #27, run a clean empty-directory process test that creates one listener and one SQLite file, registers one Hub, receives its first observation, and shows it in the browser-facing API. Record process/listener/DB counts. |
| 2 | `tools/test/publication.test.mjs` creates v2 config without Collector inputs; `tools/release.mjs` has a release allowlist | PARTIAL | Final source/package scan must prove the normal startup path has no old Collector/env/Batch/ACK/outbox import or route. Legacy helpers may remain only behind a clearly migration-only entry point. |
| 3 | `analytics/test/core.test.mjs` covers synchronous transactions, COMMIT-visible state, stale/late observations, null/zero, rollback, and SQL-call bound; `analytics/test/collection.test.mjs` covers storage failure | COVERED | Add/retain a process-level assertion that ACK/notification cannot precede COMMIT after #27 removes the old bridge, then attach the final-SHA log. |
| 4 | `analytics/test/collection.test.mjs` covers UTF-8/BOM/SSE framing, heartbeats, auth/redirect/header timeout, reconnect backoff, and per-Hub manager races; `analytics/test/auth.test.mjs` covers viewer authentication; `rootd3ded24` has the integration-manage CRUD/SSE/history-restore result | PARTIAL | Attach the `d3ded24` execution log to the final acceptance bundle and add a bounded browser/client process artifact showing normal close and reconnect with one failed Hub isolated from another. |
| 5 | `analytics/test/hubs.test.mjs` covers SQLite CRUD/CAS/archive, secret replacement, missing secret, DB failure after secret write; collection tests cover manager removal/replacement | COVERED | Final management process run must show add/stop/restart/delete and stale callback fencing with no legacy Collector route. |
| 6 | `analytics/test/history.test.mjs` covers revisions, dirty coalescing, fetch bounds, replacement, min interval, and races | COVERED | Keep the post-#27 schema/source revision proof and show a manual-fetch trigger cannot invent a matching revision, then attach its final-SHA log. |
| 7 | `analytics/test/history.test.mjs` covers deletion/disabled/null/missing capability, malformed/permanent errors, size limit, and retained rows; `analytics/src/history.ts` bounds devices/rows/maps | PARTIAL | Add explicit correction/timezone/zero/unknown/unsupported/huge fixtures at the final API boundary and check complete totals have no duplicate rows. |
| 8 | History replacement and daily/monthly aggregation tests exist in `analytics/test/history.test.mjs` and `tools/test/mockhub.test.mjs` | PARTIAL | Process-level stopped-crossing-day fixture must prove no duplicate daily/monthly rows and that history queries do not affect live limits/evaluation. |
| 9 | `analytics/test/history.test.mjs` checks the 16 MiB body limit; the performance preflight records the preliminary SQLite cost; `analytics/runtime/server.mjs` has bounded close logic | GAP | Measure accepted near-16 MiB and rejected over-16 MiB HTTP bodies, save latency while `/api/health` and `/api/state` are requested, and `app.close()` with in-flight requests. Publish practical thresholds and raw JSON timings. |
| 10 | `tools/test/reset-hubs.test.mjs` covers drain retention until all events are acknowledged; backup logic is covered by `analytics/test/native.test.mjs` | GAP / #27 | Run the final reset/migration fixture only after #27 lands: interrupted/unknown/corrupt ACKs, rerun, backup restore, and a readable reset history DB with zero registered Hubs. Do not run the unsafe pre-eec integration. |
| 11 | `.mise.toml` defines analytics tests, publication tests, typecheck, three integrations, and amd64/arm64 package checks; prior logs include `update-safe-review.log`, `publication-review.log`, and `tools-baseline.log` | PARTIAL | Regenerate one final command bundle after #27/#28: `npm --prefix analytics test`, `npm --prefix analytics run typecheck`, all `tools/test`, all three integrations, and both package checks. Attach Linux and Windows logs, and run Go checks only while the transitional tree still exists. |
| 12 | Path/BOM/spaces tests are in `analytics/test/native.test.mjs`; Linux flock and Windows fallback lock tests are in `tools/test/publication.test.mjs`; user-systemd test is in `tools/test/user-service.test.mjs`; Tailscale contract tests are in `analytics/test/tailnet.test.mjs` and `tools/test/updater-provision.test.mjs` | PARTIAL / GAP | Windows: execute path-with-spaces, Ctrl+C, replacement while a reader holds the file, concurrent lock, and exact ACL tests. Ubuntu: use an isolated guest for user service, reboot/autostart, one-shot update, and approved Tailscale bind; no host reboot. |
| 13 | `analytics/test/native.test.mjs` checks no old ingest/status endpoint; package allowlist excludes Collector; auth and secret tests check separation; release tests check old layout and config IDs | PARTIAL | Final grep/package/static/log scan must prove secrets never enter DB/API/log/static/package, no double listener or old route exists, and configuration polling is not restored. |
| 14 | `tools/test/update-runner.test.mjs` covers candidate SHA, restart, job identity and terminal stages; `analytics/test/update*.test.mjs` covers management state and same-content no-op; `tools/integration-update.mjs` supplies the mock remote | PARTIAL / #26 | Run with the final #27 runner/app closure: candidate→SHA verification, same job ID across restart, app-stopped runner, SSE/history resume, and actual user-service invocation. The current Windows integration null-`targetCommitSha` failure belongs to #26. |
| 15 | `tools/test/update-runner.test.mjs` covers preflight-before-stop, branch move, post-start proof failure, killed runner, lock, and state reconciliation; `analytics/test/update-restart.test.mjs` covers terminal health failure and no-op | PARTIAL | Add process evidence for startup failure, runner kill, terminal state persistence, health race, fixed SHA, and CLI/Web lock while the real app is stopped. |
| 16 | `tools/test/updater-provision.test.mjs` checks runner dependency closure, no app config/source checkout, old lock rejection, and packaged user units; `tools/test/update-runner.test.mjs` uses an isolated copied runner | COVERED | Final package extraction must repeat the closure/source scan after #27 and include the archive checksum. |
| 17 | Provision tests reject legacy system/user units without mutation; `tools/test/reset-hubs.test.mjs` covers drain mechanics | GAP / #27 | Need the actual old-runner rejection, compatible Web update after migration, recovery from service/runner/infra failure, and maintenance lockouts. Do not touch the active old host services. |
| 18 | `tools/test/publication.test.mjs` covers same-content publication, config identity, and source/payload verification; management tests cover Hub edits and observations | PARTIAL | Final publish fixture must prove Hub rows/secret survive publication, observation and Hub edit do not restart the app, update controls stay outside DB, and terminal completion is not overwritten. |

## Direct #28 gates

| #28 gate | Required evidence | Current result |
| --- | --- | --- |
| Windows native behavior | GitHub Actions Windows job with checkout path `workspace with spaces`; path/BOM, Ctrl+C, file lock/replacement, and exact ACL results | Path/BOM and most native tests reached the job. The ACL and fixed-Node fixes are in this branch; Windows execution is still required. Ctrl+C and a held-reader replacement test are still gaps. |
| Ubuntu service/autostart | Isolated Ubuntu 24.04 guest: `systemctl --user is-enabled/active`, health, user service restart, guest reboot, post-boot health and enabled state | Not run. The host has active old production services and no sudo permission. |
| Tailscale boundary | Approved isolated environment with a real CGN Tailscale interface: one listener on the selected address, viewer works through it, and the removed legacy ingest surface is absent | PASS on parent SHA `63f0d07`: `/tmp/tma-orchestration/tailnet-real-63f0d07.log` records 3 passes and 0 skips with an independent temporary DB/port; no existing service changed |
| Real one-shot self-update | The final user service starts `tma-update.service` only on demand; candidate SHA and archive are verified; app restarts to the same job; DB/Hub secret/config and SSE/history survive | Fixture/unit coverage exists; actual user-systemd one-shot is not run. The current Windows integration failure is #26-owned. |
| History limit and shutdown | Exact near/over-16 MiB HTTP fixtures, response latency during the synchronous transaction, and bounded close with in-flight requests | Size-limit unit exists; the performance preflight is below the limit and has no HTTP/shutdown data. |

## Windows ACL and lock change in this branch

`analytics/runtime/hubs.mjs` now uses an inbox PowerShell `Get-Acl`/`Set-Acl`
operation on a newly-created empty secret temp file. It disables inheritance,
purges every existing ACE, and adds only the creating account, LocalSystem,
and local Administrators before any secret bytes are written or the temp file
is renamed. The generic migration-only `writeAtomicFile` does not rewrite a
caller's directory ACL.

`analytics/test/hubs.test.mjs` deliberately gives the secret's parent an
inherited Everyone full-control ACE, then checks the resulting SDDL contains
exactly three full-control allow ACEs for the owner, SYSTEM, and Administrators
with no inherited flags. The test uses `icacls`/PowerShell ACL evidence on
Windows and POSIX mode only on POSIX. This catches the earlier
`/inheritance:r /grant:r` approach, which could leave explicit broad ACEs.

`tools/test/publication.test.mjs` uses `node.exe` for the copied Windows fixed
runtime and exercises the Windows `O_EXCL` publication lock with a concurrent
child. The Ubuntu symlink-swap/real HTTP publisher test is explicitly skipped
on Windows because that publisher is an Ubuntu service operation; Windows
coverage must come from the native app and integration jobs. A hard-killed
Windows lock owner can leave the fallback lock file, so the final acceptance
must either document and clean that recovery path or add an explicit stale-lock
protocol before calling the lock gate complete.

## Bounded Ubuntu guest implementation

`tools/test/ubuntu-reboot-vm.sh` and the manual
`.github/workflows/ubuntu-reboot.yml` now implement the bounded CI shape: a
pinned Ubuntu 24.04 cloud image (`release-20260826`, SHA-256
`d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30`) and an
isolated QEMU guest, never a host reboot. The job installs
`qemu-system-x86_64` and `cloud-localds`, uses `-accel kvm:tcg` (KVM is an
optional acceleration path), connects through user-mode SSH, and has a
50-minute job timeout. It uploads serial console, service status, health, and
post-reboot logs.

The guest sequence is:

1. Install the fixed Node runtime and the final package as an ordinary user;
   use the already-tested privileged provisioning contract only inside the
   guest, with no host paths or old host services.
2. Configure one loopback listener and a local bare Git fixture. Assert that
   `tma-analytics.service` is enabled/active and `tma-update.service` is not
   enabled. Check health, SQLite, and the private secret file.
3. Trigger the management update, verify candidate and archive SHA, confirm
   the one-shot runner stops/starts the app and retains one job ID, then check
   the same DB/config/secret and a resumed SSE/history connection.
4. Issue `sudo reboot` inside the guest, wait for SSH, and assert user linger,
   enabled/active Analytics, healthy listener, preserved DB/secret, and no
   automatically-running update unit.

The workflow is manual because it downloads a pinned 24.04 image and runs the
full release verification gate. Its artifact is required for closing the
Ubuntu reboot/autostart row; a workflow that has not been dispatched remains a
GAP.

The parent SHA already has a real-interface artifact at
`/tmp/tma-orchestration/tailnet-real-63f0d07.log`. Generic CI still has no safe
reusable tailnet credential, so that isolated run remains the evidence for the
Tailscale boundary while the QEMU job below covers service/reboot behavior.

## History performance plan

Add a bounded tool test or standalone fixture that generates valid history at
the protocol limits (256 devices, no more than 4,096 rows per device), then
runs three cases: a body just below 16 MiB, a body just above 16 MiB, and the
256-device/370-day baseline. Send each through the real native HTTP endpoint,
record parse/normalize time, SQLite transaction time, HTTP response latency
for health/state requests made during the save, and `app.close()` time with a
request in flight. Store raw measurements under `/tmp/tma-orchestration`.

Set practical thresholds before interpreting the run. The 3.49 s transaction
from the preflight is a measured baseline, not an acceptance threshold; it
must be reported with the concurrent HTTP and close timings. Do not replace
the single synchronous transaction with a worker or a second database merely
to improve this measurement.

## Final evidence bundle and blockers

The final bundle should include the exact commit SHA, Linux/Windows CI URLs or
logs, the QEMU guest artifact, the Tailscale isolated-run artifact, performance
JSON, package checksums, and the updated `docs/VERIFICATION.md`. Until #27 is
merged, the clean migration/reset run, final source scan, and actual one-shot
self-update remain blocked. The present Windows `targetCommitSha` null failure
is tracked by #26; this branch does not change the migration work or the
unsafe pre-eec integration.
