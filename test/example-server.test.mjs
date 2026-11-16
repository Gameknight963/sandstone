import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {once} from 'node:events';
import {create_relay_server} from '../example/http.mjs';

test('Example server treats h2c and unsupported upgrades as normal HTTP, including POST bodies', async () => {
  const upgrades = [];
  const server = create_relay_server(async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    response.end(JSON.stringify({method:request.method,body:Buffer.concat(parts).toString(),path:request.url}));
  });
  server.on('upgrade', (request, socket) => {
    upgrades.push(request.headers.upgrade);
    socket.end('HTTP/1.1 418 Upgrade handler\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const send = (upgrade, method = 'GET', body = '') => new Promise((resolve, reject) => {
    const outgoing = request({host:'127.0.0.1',port:server.address().port,path:'/fixture',method,agent:false,
      headers:{Connection:'Upgrade',Upgrade:upgrade,...(body?{'Content-Length':Buffer.byteLength(body)}:{})}}, response => {
      const parts=[];response.on('data',chunk=>parts.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(parts).toString()}));
    });
    outgoing.on('error',reject);outgoing.end(body);
  });
  try {
    for (const protocol of ['h2c','unknown']) {
      assert.deepEqual(await send(protocol),{status:200,body:JSON.stringify({method:'GET',body:'',path:'/fixture'})});
      assert.deepEqual(await send(protocol,'POST','submitted €'),{status:200,body:JSON.stringify({method:'POST',body:'submitted €',path:'/fixture'})});
    }
    assert.deepEqual(upgrades,[]);
    assert.equal((await send('WebSocket')).status,418);
    assert.deepEqual(upgrades,['WebSocket']);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
