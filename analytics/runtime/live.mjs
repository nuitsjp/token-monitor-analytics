// Browser-side updates are one-way. SSE avoids a WebSocket dependency on native Node.
export class LiveFeed {
 #clients=new Set();
 #timer;
 constructor({maxClients=16,heartbeatMs=25000}={}){
  this.maxClients=maxClients;
  this.#timer=setInterval(()=>this.#broadcast(': heartbeat\n\n'),heartbeatMs);
  this.#timer.unref();
 }
 attach(request,response){
  if(this.#clients.size>=this.maxClients){response.writeHead(503,{'Retry-After':'5'});response.end('viewer_limit');return;}
  response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
  response.flushHeaders();
  this.#clients.add(response);
  response.on('close',()=>this.#clients.delete(response));
  response.on('error',()=>{this.#clients.delete(response);response.destroy();});
  response.write('retry: 2000\nevent: ready\ndata: {"type":"ready"}\n\n');
 }
 updated(hubIds){this.#broadcast(`event: updated\ndata: ${JSON.stringify({type:'updated',hubIds})}\n\n`);}
 #broadcast(frame){
  for(const response of this.#clients){
   if(response.destroyed){this.#clients.delete(response);continue;}
   // Drop slow consumers rather than retaining unbounded response buffers.
   if(!response.write(frame)){this.#clients.delete(response);response.destroy();}
  }
 }
 close(){clearInterval(this.#timer);for(const response of this.#clients)response.end();this.#clients.clear();}
 get size(){return this.#clients.size;}
}
