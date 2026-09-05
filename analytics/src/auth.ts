import type {Env} from './platform.js';
export function localMode(request:Request,env:Env):boolean{
 return env.AUTH_MODE==='local'&&['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname);
}
export async function checkIngest(request:Request,env:Env):Promise<boolean>{
 const secret=env.INGEST_TOKEN;
 if(!secret||secret.length<16)return false;
 const header=request.headers.get('authorization')??'';
 if(header.length>4096||!header.startsWith('Bearer '))return false;
 const enc=new TextEncoder();const a=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(header.slice(7))));
 const b=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(secret)));let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]!^b[i]!;return diff===0;
}
interface Key extends JsonWebKey {kid?:string}
const cache=new Map<string,{until:number;keys:Key[]}>();
function b64(s:string):Uint8Array{
 if(!/^[a-zA-Z0-9_-]+$/.test(s))throw new Error('base64url');
 return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
}
function decode(s:string):Record<string,unknown>{const value=JSON.parse(new TextDecoder().decode(b64(s)));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('JSON object required');return value;}
// Narrow Cloudflare Access RS256 validator. Rejects unsigned/HS tokens, wrong
// issuer/audience, invalid time bounds and tokens whose signing key is unknown.
export async function verifyJWT(token:string,domain:string,audience:string,fetcher:typeof fetch=fetch,now=Date.now()):Promise<number>{
 if(!/^[a-zA-Z0-9-]+\.cloudflareaccess\.com$/.test(domain)||!audience||token.length>16384)throw new Error('invalid Access configuration or token');
 const parts=token.split('.');if(parts.length!==3)throw new Error('invalid JWT');const [h,p,s]=parts as [string,string,string];
 const header=decode(h),claims=decode(p);
 if(header.alg!=='RS256'||typeof header.kid!=='string'||header.crit!==undefined)throw new Error('unsupported signing key');
 const aud=typeof claims.aud==='string'?[claims.aud]:claims.aud;
 if(claims.iss!==`https://${domain}`||!Array.isArray(aud)||!aud.includes(audience)||typeof claims.exp!=='number'||claims.exp*1000<=now||!Number.isFinite(claims.exp))throw new Error('invalid JWT claims');
 if(claims.nbf!==undefined&&(typeof claims.nbf!=='number'||!Number.isFinite(claims.nbf)||claims.nbf*1000>now+30000))throw new Error('JWT not yet valid');
 let entry=cache.get(domain);
 if(!entry||entry.until<=now){
  const response=await fetcher(`https://${domain}/cdn-cgi/access/certs`,{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('Access keys unavailable');
  const doc=await response.json() as {keys?:Key[]};if(!Array.isArray(doc.keys)||doc.keys.length>20)throw new Error('invalid key document');
  entry={until:now+300000,keys:doc.keys};cache.set(domain,entry);
 }
 const jwk=entry.keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(k.alg===undefined||k.alg==='RS256')&&(k.use===undefined||k.use==='sig'));
 // Unknown rotated key: fail closed; cache expires in 5 minutes, never refetch on arbitrary attacker kids.
 if(!jwk)throw new Error('unknown signing key');
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,b64(s),new TextEncoder().encode(`${h}.${p}`)))throw new Error('signature mismatch');
 return claims.exp*1000;
}
export async function viewerExpiry(request:Request,env:Env):Promise<number>{
 if(localMode(request,env))return Date.now()+3600000;
 const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token)throw new Error('Access login required');
 return verifyJWT(token,env.ACCESS_TEAM_DOMAIN??'',env.ACCESS_AUD??'');
}
