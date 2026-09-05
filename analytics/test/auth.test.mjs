import test from 'node:test';
import assert from 'node:assert/strict';
import {canIngest,canView,allowedRequest} from '../runtime/auth.mjs';

const auth={
 ingest:'collector-ingest-token-that-is-long-enough',
 user:'viewer',
 password:'viewer-password-that-is-long-enough'
};
const loopbackConfig={viewerAuth:{mode:'loopback'}};
const basicConfig={viewerAuth:{mode:'basic'}};
const request=(headers={},remoteAddress='127.0.0.1')=>({headers,socket:{remoteAddress}});
const basic=(user,password)=>`Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

test('loopback viewer trusts the socket address, not forwarded identity headers',()=>{
 const externalClaim={
  'x-forwarded-for':'203.0.113.10',
  'x-real-ip':'203.0.113.10',
  forwarded:'for=203.0.113.10'
 };
 for(const address of ['127.0.0.1','::1','::ffff:127.0.0.1']){
  assert.equal(canView(request(externalClaim,address),loopbackConfig,auth),true,address);
 }
 const loopbackClaim={
  'x-forwarded-for':'127.0.0.1',
  'x-real-ip':'127.0.0.1',
  forwarded:'for=127.0.0.1'
 };
 for(const address of ['192.0.2.10','::ffff:192.0.2.10','2001:db8::10']){
  assert.equal(canView(request(loopbackClaim,address),loopbackConfig,auth),false,address);
 }
});

test('Basic viewer auth rejects wrong, missing, and malformed credentials',()=>{
 const cases=[
  ['matching credentials',basic(auth.user,auth.password),true],
  ['wrong user',basic('other',auth.password),false],
  ['wrong password',basic(auth.user,'wrong-password'),false],
  ['missing header',undefined,false],
  ['missing password',basic(auth.user,''),false],
  ['missing colon',`Basic ${Buffer.from(auth.user).toString('base64')}`,false],
  ['wrong scheme',`Bearer ${auth.ingest}`,false],
  ['invalid Basic value','Basic not-base64',false]
 ];
 for(const [label,authorization,expected] of cases){
  const headers=authorization===undefined?{}:{authorization};
  assert.equal(canView(request(headers,'198.51.100.10'),basicConfig,auth),expected,label);
 }
});

test('collector Bearer auth and viewer Basic auth are separate credentials',()=>{
 const bearer=request({authorization:`Bearer ${auth.ingest}`},'198.51.100.10');
 const viewer=request({authorization:basic(auth.user,auth.password)},'198.51.100.10');
 assert.equal(canIngest(bearer,auth),true);
 assert.equal(canIngest(viewer,auth),false);
 assert.equal(canView(bearer,basicConfig,auth),false);
 assert.equal(canView(viewer,basicConfig,auth),true);
});

test('request allowlist rejects hostile host, origin, fetch, and forwarded headers',()=>{
 const config={
  publicOrigin:'https://analytics.example.test',
  listen:{host:'127.0.0.1',port:8787}
 };
 const accepted=(headers={})=>allowedRequest(request({host:'analytics.example.test',...headers},'198.51.100.10'),config);
 assert.equal(accepted(),true);
 assert.equal(accepted({origin:config.publicOrigin}),true);
 for(const host of ['attacker.example.test','analytics.example.test:9999',undefined]){
  const headers=host===undefined?{}:{host};
  assert.equal(allowedRequest(request(headers,'198.51.100.10'),config),false,String(host));
 }
 assert.equal(accepted({origin:'https://attacker.example.test'}),false);
 assert.equal(accepted({'sec-fetch-site':'cross-site'}),false);
 assert.equal(allowedRequest(request({
  host:'attacker.example.test',
  forwarded:'host=analytics.example.test;proto=https',
  'x-forwarded-host':'analytics.example.test'
 },'198.51.100.10'),config),false);
 for(const host of ['127.0.0.1:8787','localhost:8787','[::1]:8787']){
  assert.equal(allowedRequest(request({host},'127.0.0.1'),config),true,host);
 }
});
