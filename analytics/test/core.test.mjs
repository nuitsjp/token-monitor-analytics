import test from 'node:test';import assert from 'node:assert/strict';
import {advance,dayKey,validateContracts} from '../.test-build/estimate.js';
import {parseBatch,readLimited} from '../.test-build/protocol.js';
import {database,contract as c,observation as o} from './adapter.mjs';
import {ingest,dashboard,history,prune} from '../.test-build/db.js';
const run=(a,b,cc=c)=>advance(cc,b,advance(cc,a,null));
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
test('definition limit guards query budget',()=>assert.throws(()=>validateContracts(Array(9).fill(c),['hub-a'])));
test('protocol accepts legitimate batch and canonicalizes dates',()=>{const b=parseBatch({schemaVersion:1,events:[o()]},['hub-a']);assert.equal(b.events[0].observedAt,'2026-09-05T00:00:00.000Z')});
test('protocol rejects unknown hub / invalid percent / future clock',()=>{assert.throws(()=>parseBatch({schemaVersion:1,events:[o()]},[]));const x=o();x.stats.limits.providers[0].windows[0].usedPercent=101;assert.throws(()=>parseBatch({schemaVersion:1,events:[x]},['hub-a']));assert.throws(()=>parseBatch({schemaVersion:1,events:[o()]},['hub-a'],0))});
test('oversized body rejected',async()=>{await assert.rejects(readLimited(new Request('https://test',{method:'POST',body:'123456'}),5))});
test('D1 adapter transaction, dedupe, daily last-valid retention',async()=>{
 const db=database();await ingest(db,{events:[o(),o(1)]},[c],'Asia/Tokyo');assert.equal(db.sql.prepare('SELECT count(*) n FROM observations').get().n,2);
 await ingest(db,{events:[o(1)]},[c],'Asia/Tokyo');assert.equal(db.sql.prepare('SELECT count(*) n FROM observations').get().n,2);
 let rows=await history(db,c.id);assert.equal(rows[0].window_capacity_usd,160);
 const x=o(2);x.stats.limits.providers[0].stale=true;await ingest(db,{events:[x]},[c],'Asia/Tokyo');rows=await history(db,c.id);assert.equal(rows[0].status,'unavailable');assert.equal(rows[0].window_capacity_usd,160);assert.equal(rows[0].last_valid_at,o(1).observedAt);
 assert.equal((await dashboard(db,[c])).hubs[0].eventId,x.eventId);db.sql.close();
});
test('late events never overwrite latest / baseline',async()=>{const db=database();await ingest(db,{events:[o(2)]},[c],'Asia/Tokyo');await ingest(db,{events:[o()]},[c],'Asia/Tokyo');assert.equal((await dashboard(db,[c])).hubs[0].eventId,o(2).eventId);db.sql.close()});
test('prune preserves latest snapshot',async()=>{const db=database();await ingest(db,{events:[o(),o(1)]},[c],'Asia/Tokyo');await prune(db,7,Date.parse('2027-01-01T00:00:00Z'));assert.equal(db.sql.prepare('SELECT count(*) n FROM observations').get().n,1);assert.equal((await dashboard(db,[c])).hubs.length,1);db.sql.close()});
test('SQLite batch rolls back all statements on failure',async()=>{const db=database();await assert.rejects(db.batch([db.prepare("INSERT INTO hub_latest VALUES('a','b','c')"),db.prepare('INSERT INTO missing_table VALUES(1)')]));assert.equal(db.sql.prepare('SELECT count(*) n FROM hub_latest').get().n,0);db.sql.close()});

test('unknown/private fields are not persisted from a future client',()=>{const x=o();x.secret='bad';x.stats.limits.providers[0].accountEmail='private@example.com';const b=parseBatch({schemaVersion:1,events:[x]},['hub-a']);assert.equal(JSON.stringify(b).includes('private@example'),false);assert.equal('secret' in b.events[0],false)});
test('eight definitions and two events stay within forty SQL calls',async()=>{const db=database();let calls=0;const original=db.prepare;db.prepare=(...a)=>{calls++;return original(...a)};const cs=Array.from({length:8},(_,i)=>({...c,id:`c${i}`}));await ingest(db,{events:[o(),o(1)]},cs,'Asia/Tokyo');assert.ok(calls<=40,`queries: ${calls}`);db.sql.close()});
