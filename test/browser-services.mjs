// Loopback-only Wisp/HTTP fixture for the .NET browser workflows. Assertions and
// browser orchestration live in C#; this reuses the application's relay server.
import {readFile} from 'node:fs/promises';
import {create_relay_server} from '../example/http.mjs';
import {server as wisp,logging} from '../example/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs';
import {listen_browser_server} from './browser-server.mjs';
import {track_client_sockets} from './client-sockets.mjs';
import LZString from 'lz-string';
const sockets=new Set(),closeClients=track_client_sockets();
const server=create_relay_server(async(request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/decode-flems'){
    // Reuse the app's JS compression library; C# owns the persistence assertions.
    try{const state=JSON.parse(LZString.decompressFromEncodedURIComponent((url.searchParams.get('hash')||'').slice(3)));response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(state));}
    catch{response.writeHead(400);response.end('Invalid Flems state');}
  }else if(request.url==='/host'){
    response.writeHead(200,{'content-type':'text/html','cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp'});
    response.end(await readFile(new URL('../example/bundled.html',import.meta.url)));
  }else{response.writeHead(404);response.end();}
});
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
server.on('upgrade',(request,socket,head)=>wisp.routeRequest(request,socket,head));
wisp.options.port_whitelist=[80,443];wisp.options.allow_loopback_ips=false;logging.set_level(logging.WARN);
await listen_browser_server(server);
console.log(JSON.stringify({origin:'http://127.0.0.1:'+server.address().port,relay:'ws://127.0.0.1:'+server.address().port+'/'}));
let closing=false;
function close(){if(closing)return;closing=true;for(const socket of sockets)socket.destroy();closeClients();server.close(()=>process.exit(0));}
process.stdin.resume();process.stdin.on('end',close);process.on('SIGTERM',close);process.on('SIGINT',close);
