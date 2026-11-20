import * as rpc from '../rpc.mjs';
import * as loader from './loader.mjs';
import * as network from './network.mjs';
import {create_sync_http_server} from '../sync_http.mjs';
import {restore_sync_body} from '../sync_http_body.mjs';
import {serialize_request} from './polyfill/request.mjs';
import {on_document_unload} from './runtime_events.mjs';

const channels=new Map();
rpc.rpc_handlers.worker_sync_close=token=>{
  const channel=channels.get(token);if(!channel)return;
  channels.delete(token);channel.server.close();channel.port.close();
};
rpc.rpc_handlers.worker_sync_bind=(id,token,port,context)=>{
  rpc.rpc_handlers.worker_sync_close(token);
  const server=create_sync_http_server({fetch:async(url,options,signal)=>{
    if(url==='sandstone-filesystem:command'){
      let result,bytes;
      try{
        const value=await rpc.call_procedure(rpc.host,'worker_sync_request',[loader.frame_id,id,token,'file',options.filesystem]);
        if(value?.bytes instanceof Uint8Array){bytes=value.bytes;result={};}else result={value};
      }catch(error){result={error:{name:error.name,message:error.message}};}
      return new Response(bytes,{headers:{'x-sandstone-file-result':encodeURIComponent(JSON.stringify(result))}});
    }
    const owner={id,context:token,script:options.script===true};
    if(owner.script)return network.fetch(url,{signal,sandstone_sync_worker:owner,referrerPolicy:context.referrerPolicy});
    const request=await serialize_request(url,{method:options.method,headers:options.headers,body:restore_sync_body(options.body),credentials:options.credentials,signal},context.url,context.url);
    signal.throwIfAborted();
    return network.fetch(request.url,{...request.options,signal,sandstone_sync_worker:owner,referrerPolicy:context.referrerPolicy});
  }});
  channels.set(token,{server,port});port.onmessage=event=>server.receive(event.data);port.start();
};
on_document_unload(()=>{for(const token of channels.keys())rpc.rpc_handlers.worker_sync_close(token);});
