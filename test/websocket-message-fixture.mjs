export const is_websocket_message_path=input=>new URL(input,'http://fixture/').pathname.startsWith('/ws-message-check/');
export function websocket_message_connection(socket,request){
  if(!is_websocket_message_path(request.url))return false;
  const mode=new URL(request.url,'http://fixture/').pathname.split('/').at(-1);
  socket.on('error',()=>{});
  if(mode==='receive')socket.once('message',()=>{
    socket.send(Buffer.from([65,0xe2]),{binary:false,fin:false});socket.ping('probe');socket.pong('quiet');
    socket.send(Buffer.from([0x82]),{binary:false,fin:false});socket.send(Buffer.from([0xac,90]),{binary:false,fin:true});
    socket.send(Buffer.from([0,1]),{binary:true,fin:false});socket.send(Buffer.alloc(0),{binary:true,fin:false});socket.send(Buffer.from([2,3,4]),{binary:true,fin:true});
    socket.send('');socket.send(Buffer.alloc(0));socket.send('x'.repeat(65536));
    for(const length of [65536,65537,1048576])socket.send(Buffer.from(Array.from({length},(_,index)=>index%251)));
    socket.close(1000,'complete');
  });
  else socket.on('message',(data,binary)=>{let sum=0;for(const byte of data)sum=(sum+byte)>>>0;socket.send(JSON.stringify({binary,length:data.length,sum}));});
  return true;
}

async function message_run(origin,mode){
  const socket=new WebSocket(origin.replace(/^http/,'ws')+'/ws-message-check/'+mode),messages=[],events=[];
  socket.binaryType='arraybuffer';
  const summarize=data=>{
    const text=typeof data==='string',bytes=text?Array.from(data,character=>character.codePointAt(0)):new Uint8Array(data);let sum=0;
    for(const byte of bytes)sum=(sum+byte)>>>0;
    return {text,length:bytes.length,first:bytes[0]??null,last:bytes[bytes.length-1]??null,sum};
  };
  let finish,fail,next;
  const done=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  const timer=setTimeout(()=>{socket.close();fail(new Error('WebSocket message timeout: '+mode));},10000);
  socket.onerror=()=>events.push('error');
  socket.onmessage=event=>{if(mode==='receive')messages.push(summarize(event.data));else next?.(JSON.parse(event.data));};
  socket.onclose=event=>{clearTimeout(timer);finish(JSON.stringify({messages,events,code:event.code,wasClean:event.wasClean}));};
  socket.onopen=async()=>{
    events.push('open');
    if(mode==='receive'){socket.send('start');return;}
    try{
      for(const length of [65536,65537,1048576]){
        const received=new Promise(resolve=>{next=resolve;});
        socket.send(Uint8Array.from({length},(_,index)=>index%251));messages.push(await received);
      }
      socket.close(1000,'complete');
    }catch(error){clearTimeout(timer);fail(error);}
  };
  return done;
}
export const websocket_message_script=(origin,mode)=>'('+message_run.toString()+')('+JSON.stringify(origin)+','+JSON.stringify(mode)+')';
