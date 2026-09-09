import test from 'node:test';import assert from 'node:assert/strict';
import {advance,dayKey,validateContracts} from '../src/estimate.ts';
import {database,transaction,contract as c,observation as o} from './adapter.mjs';
import {recordObservation,recordObservations,dashboard,history,prune} from '../src/db.ts';
const run=(a,b,cc=c)=>advance(cc,b,advance(cc,a,null));
const internal=x=>{const {schemaVersion,eventId,...observation}=x;return observation;};
test('native storage boundary is synchronous',()=>{const db=database();assert.equal(db.prepare('SELECT 1 n').get().n,1);assert.equal(db.prepare('SELECT 1 n').all()[0].n,1);assert.equal(typeof db.prepare('CREATE TABLE sync_probe (n INTEGER)').run().changes,'number');assert.equal(typeof db.batch,'undefined');db.close()});
test('same-window deltas use 0..100 percentage correctly',()=>{const s=run(o(),o(1));assert.equal(s.result.windowCapacityUsd,160);assert.ok(Math.abs(s.result.monthlyCapacityUsd-695.7)<0.01)});
test('small percentage changes accumulate from baseline',()=>{let s=advance(c,o(),null);const a=o(1);a.stats.limits.providers[0].windows[0].usedPercent=11;s=advance(c,a,s);assert.equal(s.result.status,'observing');s=advance(c,o(2),s);assert.equal(s.result.windowCapacityUsd,160)});
for(const [name,change,reason] of [
 ['attribution',(_x,c)=>{c.attributionConfirmed=false},'attribution_unconfirmed'],
 ['stale limits',x=>{x.stats.limits.providers[0].stale=true},'limits_unavailable_or_stale'],
 ['missing cost',x=>{delete x.stats.devices[0].periods.allTime.clientCosts.claude},'cost_missing'],
 ['source skew',x=>{x.stats.devices[0].updatedAt='2026-09-04T23:56:00Z'},'source_time_mismatch'],
 ['ambiguous window',x=>{x.stats.limits.providers[0].windows.push({...x.stats.limits.providers[0].windows[0]})},'window_missing_or_ambiguous'],
 ['reconnect',x=>{x.streamId='b'.repeat(32)},'stream_reconnected'],
 ['reset',x=>{x.stats.limits.providers[0].windows[0].resetsAt='2026-09-19T00:00:00Z'},'window_reset'],
 ['cost decreases',x=>{x.stats.devices[0].periods.allTime.clientCosts.claude=50},'counter_decreased']
])test(name,()=>{const x=o(1),cc=structuredClone(c);change(x,cc);assert.equal(run(o(),x,cc).result.reason,reason)});
test('configuration change resets baseline',()=>{const a=advance(c,o(),null),cc={...c,label:'Changed'};assert.equal(advance(cc,o(1),a).result.reason,'baseline_started')});
test('JST day boundary is explicit',()=>assert.equal(dayKey('2026-09-04T16:00:00Z','Asia/Tokyo'),'2026-09-05'));
test('definition limit remains explicit',()=>assert.throws(()=>validateContracts(Array(9).fill(c),['hub-a'])));
test('recordObservation generates a local ID and drops unknown fields',()=>{
 const db=database(),input={...internal(o()),privateField:'must-not-persist'};
 const changed=transaction(db,()=>recordObservation(db,input,[c],'Asia/Tokyo'));
 const row=db.prepare('SELECT event_id,payload FROM observations').get();const saved=JSON.parse(row.payload);
 assert.deepEqual(changed,['hub-a']);assert.match(row.event_id,/^[a-f0-9]{32}$/);assert.equal(saved.eventId,row.event_id);assert.equal(saved.schemaVersion,1);assert.equal(saved.privateField,undefined);db.close();
});
test('internal observation API always generates a new ID',()=>{
 const db=database(),id='b'.repeat(32),first={...internal(o()),eventId:id},second={...internal(o(1)),eventId:id};
 transaction(db,()=>recordObservation(db,first,[c],'Asia/Tokyo'));
 transaction(db,()=>recordObservation(db,second,[c],'Asia/Tokyo'));
 const rows=db.prepare('SELECT event_id FROM observations ORDER BY observed_at').all();
 assert.equal(rows.length,2);assert.notEqual(rows[0].event_id,id);assert.notEqual(rows[1].event_id,id);assert.notEqual(rows[0].event_id,rows[1].event_id);db.close();
});
test('zero remains a valid counter while null is unavailable',()=>{
 const zero=o();zero.stats.limits.providers[0].windows[0].usedPercent=0;zero.stats.devices[0].periods.allTime.clientCosts.claude=0;
 const next=o(1);next.stats.limits.providers[0].windows[0].usedPercent=5;next.stats.devices[0].periods.allTime.clientCosts.claude=8;
 const estimated=advance(c,next,advance(c,zero,null));assert.equal(estimated.result.status,'estimated');assert.equal(estimated.result.windowCapacityUsd,160);
 const missing=o();missing.stats.limits.providers[0].windows[0].usedPercent=null;assert.equal(advance(c,missing,null).result.status,'unavailable');
});
test('synchronous observation transaction, daily last-valid retention',()=>{
 const db=database();transaction(db,()=>recordObservations(db,[internal(o()),internal(o(1))],[c],'Asia/Tokyo'));assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n,2);
 let rows=history(db,c.id);assert.equal(rows[0].window_capacity_usd,160);
 const x=o(2);x.stats.limits.providers[0].stale=true;transaction(db,()=>recordObservation(db,internal(x),[c],'Asia/Tokyo'));rows=history(db,c.id);assert.equal(rows[0].status,'unavailable');assert.equal(rows[0].window_capacity_usd,160);assert.equal(rows[0].last_valid_at,o(1).observedAt);
 assert.equal(dashboard(db,[c]).hubs[0].observedAt,x.observedAt);db.close();
});
test('internal observation API generates independent local IDs',()=>{const db=database();transaction(db,()=>recordObservation(db,internal(o()),[c],'Asia/Tokyo'));transaction(db,()=>recordObservation(db,internal(o()),[c],'Asia/Tokyo'));assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n,2);db.close()});
test('late and same-time observations never overwrite latest / baseline',()=>{const db=database();transaction(db,()=>recordObservation(db,internal(o(2)),[c],'Asia/Tokyo'));const before=db.prepare('SELECT event_id FROM hub_latest WHERE hub_id=?').get('hub-a').event_id;transaction(db,()=>recordObservation(db,internal(o(2)),[c],'Asia/Tokyo'));assert.equal(db.prepare('SELECT event_id FROM hub_latest WHERE hub_id=?').get('hub-a').event_id,before);transaction(db,()=>recordObservation(db,internal(o()),[c],'Asia/Tokyo'));assert.equal(dashboard(db,[c]).hubs[0].observedAt,o(2).observedAt);db.close()});
test('prune preserves latest snapshot',()=>{const db=database();transaction(db,()=>recordObservations(db,[internal(o()),internal(o(1))],[c],'Asia/Tokyo'));prune(db,7,Date.parse('2027-01-01T00:00:00Z'));assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n,1);assert.equal(dashboard(db,[c]).hubs.length,1);db.close()});
test('SQLite observation transaction rolls back all statements on failure',()=>{const db=database();assert.throws(()=>transaction(db,()=>{recordObservation(db,internal(o()),[c],'Asia/Tokyo');db.prepare('INSERT INTO missing_table VALUES(1)').run();}));assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM hub_latest').get().n,0);db.close()});

test('eight definitions and two events stay within forty SQL calls',()=>{const db=database();let calls=0;const original=db.prepare.bind(db);db.prepare=(...a)=>{calls++;return original(...a)};const cs=Array.from({length:8},(_,i)=>({...c,id:`c${i}`}));transaction(db,()=>recordObservations(db,[internal(o()),internal(o(1))],cs,'Asia/Tokyo'));assert.ok(calls<=40,`queries: ${calls}`);db.close()});
