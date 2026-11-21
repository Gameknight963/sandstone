import assert from 'node:assert/strict';

export const is_websocket_close_path=input=>new URL(input,'http://fixture/').pathname.startsWith('/ws-close-check/');
export function websocket_close_connection(socket,request,records){
  if(!is_websocket_close_path(request.url))return false;
  const url=new URL(request.url,'http://fixture/'),mode=url.pathname.split('/').at(-1),owner=url.searchParams.get('owner'),messages=[];
  socket.on('error',()=>{});
  socket.on('message',(data,binary)=>{messages.push({text:data.toString(),binary});if(mode==='abrupt')socket.terminate();});
  socket.on('close',(code,reason)=>records.push({owner,mode,code,reason:reason.toString(),messages}));
  if(mode==='server')socket.close(4001,'server \u20ac');
  else if(mode==='empty')socket.close();
  else if(mode==='split'){
    const payload=Buffer.concat([Buffer.from([4003>>8,4003&255]),Buffer.from('split \u20ac')]);
    // Send one control frame over three TCP writes, splitting its status and
    // the final UTF-8 character. Mark the server's close frame as already sent.
    socket._readyState=2;socket._closeFrameSent=true;
    socket._socket.write(Buffer.from([0x88,payload.length,payload[0]]));
    setTimeout(()=>socket._socket.write(payload.subarray(1,payload.length-2)),15);
    setTimeout(()=>socket._socket.write(payload.subarray(payload.length-2)),30);
  }
  return true;
}

async function close_run(origin,owner){
  const rows=[];let last;
  for(const mode of ['server','empty','client','client-empty','split','abrupt']){
    rows.push({mode,...await new Promise((resolve,reject)=>{
      const socket=last=new WebSocket(origin.replace(/^http/,'ws')+'/ws-close-check/'+mode+'?owner='+encodeURIComponent(owner)),events=[];
      const timer=setTimeout(()=>{socket.close(1000);reject(new Error('WebSocket close timed out: '+mode));},10000);
      socket.onopen=()=>{
        events.push('open');
        if(mode==='client'){socket.send(new Blob(['queued \u20ac']));socket.close(4002,'client \u20ac');}
        if(mode==='client-empty')socket.close();
        if(mode==='abrupt')socket.send('terminate');
      };
      socket.onerror=()=>events.push('error');
      socket.onclose=event=>{clearTimeout(timer);events.push('close');resolve({code:event.code,reason:event.reason,wasClean:event.wasClean,state:socket.readyState,events});};
    })});
  }
  const validation=[],capture=operation=>{try{operation();return 'allowed';}catch(error){return error.name;}};
  for(const args of [[undefined],[1000n],[1000,Symbol('reason')],[1000,'\u20ac'.repeat(42)]])validation.push(capture(()=>Reflect.apply(WebSocket.prototype.close,last,args)));
  const marker=new Error('reason');try{last.close(1001,{toString(){throw marker;}});}catch(error){validation.push(error===marker?'original conversion error':error.name);}
  return JSON.stringify({rows,validation});
}
export const websocket_close_script=(origin,owner)=>'('+close_run.toString()+')('+JSON.stringify(origin)+','+JSON.stringify(owner)+')';
export async function websocket_close_records(records,owner,count=6){
  const deadline=Date.now()+5000;
  while(records.filter(record=>record.owner===owner).length<count){assert.ok(Date.now()<deadline,'Server did not finish every WebSocket close');await new Promise(resolve=>setTimeout(resolve,10));}
  return records.filter(record=>record.owner===owner).map(({owner,...record})=>record).sort((a,b)=>a.mode.localeCompare(b.mode));
}

async function lifetime_start(origin,owner,kind){
  const url=origin.replace(/^http/,'ws')+'/ws-close-check/lifetime-'+kind+'?owner='+encodeURIComponent(owner);
  if(kind==='root')return new Promise((resolve,reject)=>{globalThis.lifetimeSocket=new WebSocket(url);lifetimeSocket.onopen=()=>resolve(true);lifetimeSocket.onerror=()=>reject(new Error('Lifetime socket failed'));});
  if(kind==='worker')return new Promise((resolve,reject)=>{
    const code='const socket=new WebSocket('+JSON.stringify(url)+');socket.onopen=()=>postMessage("ready");';
    globalThis.lifetimeWorker=new Worker(URL.createObjectURL(new Blob([code],{type:'text/javascript'})));
    lifetimeWorker.onmessage=()=>resolve(true);lifetimeWorker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};
  });
  return new Promise((resolve,reject)=>{
    const child=globalThis.lifetimeFrame=document.createElement('iframe');child.src=origin+'/ws-lifetime-child';
    const timer=setTimeout(()=>{removeEventListener('message',receive);reject(new Error('Frame lifetime socket timed out'));},5000);
    const receive=event=>{if(event.source===child.contentWindow&&event.data==='lifetime-ready'){clearTimeout(timer);removeEventListener('message',receive);resolve(true);}};addEventListener('message',receive);
    child.onload=()=>child.contentWindow.eval('const socket=new WebSocket('+JSON.stringify(url)+');socket.onopen=()=>parent.postMessage("lifetime-ready","*");');
    document.body.append(child);
  });
}
export const websocket_lifetime_script=(origin,owner,kind)=>'('+lifetime_start.toString()+')('+JSON.stringify(origin)+','+JSON.stringify(owner)+','+JSON.stringify(kind)+')';
