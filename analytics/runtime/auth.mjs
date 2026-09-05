import {createHash,timingSafeEqual} from 'node:crypto';
import {isLoopback} from './config.mjs';
const digest=value=>createHash('sha256').update(String(value)).digest();
export const equalSecret=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(digest(a),digest(b));
export function canIngest(request,auth){return equalSecret(request.headers.authorization,`Bearer ${auth.ingest}`);}
export function canView(request,config,auth){
 if(config.viewerAuth.mode==='loopback')return isLoopback(request.socket.remoteAddress);
 const header=request.headers.authorization;
 if(typeof header!=='string'||!header.startsWith('Basic ')||header.length>4096)return false;
 const value=Buffer.from(header.slice(6),'base64').toString('utf8'),colon=value.indexOf(':');
 if(colon<0)return false;
 const userOK=equalSecret(value.slice(0,colon),auth.user),passwordOK=equalSecret(value.slice(colon+1),auth.password);
 return userOK&&passwordOK;
}
// Host allowlisting rejects DNS rebinding. Proxy headers are never trusted.
export function allowedRequest(request,config){
 const host=request.headers.host;
 if(typeof host!=='string')return false;
 const allowed=new Set([new URL(config.publicOrigin).host]);
 if(isLoopback(config.listen.host)||isLoopback(request.socket.remoteAddress)){
  for(const name of ['127.0.0.1','localhost','[::1]'])allowed.add(`${name}:${config.listen.port}`);
 }
 if(!allowed.has(host))return false;
 const origin=request.headers.origin;
 if(origin && origin!==config.publicOrigin && origin!==`http://${host}`)return false;
 if(request.headers['sec-fetch-site']==='cross-site')return false;
 return true;
}
