import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedUsageRange,createUsageHistoryController,historyFetchErrorText} from '../public/usage-history.mjs';

test('automatic usage ranges stay within the API limits',()=>{
 assert.deepEqual(boundedUsageRange({dailyFrom:'2025-01-01',dailyTo:'2026-01-05'},'daily'),{
  from:'2025-01-05',to:'2026-01-05',
 });
 assert.deepEqual(boundedUsageRange({monthlyFrom:'2010-01',monthlyTo:'2020-12'},'monthly'),{
  from:'2011-01',to:'2020-12',
 });
 assert.deepEqual(boundedUsageRange({dailyFrom:'2025-01-01',dailyTo:'2025-12-31'},'daily'),{
  from:'2025-01-01',to:'2025-12-31',
 });
});

test('history fetch errors stay visible separately from the last success',()=>{
 assert.equal(historyFetchErrorText({lastStatus:'error',lastError:'unsupported'}),'Hubが履歴APIに未対応');
 assert.equal(historyFetchErrorText({lastStatus:'error',lastError:'unexpected'}),'Hub履歴の取得に失敗しました');
 assert.equal(historyFetchErrorText({lastStatus:'success',lastError:null}),'');
});

test('usage history drops responses from an old selection or request',async()=>{
 let query={hubId:'hub-a',deviceId:'device-a',granularity:'daily',from:'2026-01-01',to:'2026-01-02'};
 const pending=[];
 const applied=[];
 const controller=createUsageHistoryController({
  getQuery:()=>({...query}),
  fetchQuery:current=>new Promise((resolve,reject)=>pending.push({current,resolve,reject})),
  onApplied:(result,current)=>applied.push({result,current}),
 });

 const first=controller.load();
 query.deviceId='device-b';
 controller.invalidate();
 const second=controller.load();
 pending[1].resolve({rows:['device-b']});
 assert.deepEqual(await second,{rows:['device-b']});
 pending[0].resolve({rows:['device-a']});
 assert.equal(await first,null);
 assert.deepEqual(applied.map(item=>item.result),[{rows:['device-b']}]);
 assert.equal(applied[0].current.deviceId,'device-b');

 const third=controller.load();
 query.from='2026-02-01';
 pending[2].resolve({rows:['old-range']});
 assert.equal(await third,null);
 assert.deepEqual(applied.map(item=>item.result),[{rows:['device-b']}]);
});

test('errors from a superseded usage history request are ignored',async()=>{
 let query={hubId:'hub-a',deviceId:'device-a',granularity:'daily',from:'2026-01-01',to:'2026-01-02'};
 let rejectRequest;
 const controller=createUsageHistoryController({
  getQuery:()=>({...query}),
  fetchQuery:()=>new Promise((_resolve,reject)=>{rejectRequest=reject;}),
 });
 const request=controller.load();
 query.deviceId='device-b';
 controller.invalidate();
 rejectRequest(new Error('stale network failure'));
 assert.equal(await request,null);
});
