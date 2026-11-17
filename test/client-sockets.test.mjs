import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('Live test teardown closes pending connections and exits when a peer never finishes closing',async()=>{
  let accepted=0;
  const sockets=new Set(),server=createServer({allowHalfOpen:true},socket=>{accepted++;sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const source=`import {connect} from 'node:net';import {once} from 'node:events';import {track_client_sockets} from ${JSON.stringify(new URL('client-sockets.mjs',import.meta.url).href)};
    const cleanup=track_client_sockets(),socket=connect(${server.address().port},'127.0.0.1');await once(socket,'connect');socket.end();
    const pending=connect({host:'pending.test',port:${server.address().port},lookup(host,options,callback){setTimeout(()=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4),30);}});pending.on('error',()=>{});
    cleanup();if(!socket.destroyed||!pending.destroyed)throw new Error('A test socket survived teardown');console.log('cleaned');`;
  const child=spawn(process.execPath,['--input-type=module','--eval',source],{stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  try{
    const [code,signal]=await once(child,'close',{signal:AbortSignal.timeout(5000)});
    assert.equal(signal,null);assert.equal(code,0,errors);assert.equal(output.trim(),'cleaned');assert.equal(accepted,1);
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
