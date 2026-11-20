import {snapshot_message} from './messages.mjs';

export function create_worker_clients({command,base,encode=value=>value}){
  const records=new WeakMap(),token={};
  const state=value=>{const info=records.get(value);if(!info)throw new TypeError('Illegal Client receiver');return info;};
  class Client{
    constructor(secret,info){if(secret!==token)throw new TypeError('Illegal constructor');records.set(this,{...info});}
    get id(){return state(this).id;}
    get url(){return state(this).url;}
    get type(){return state(this).type;}
    get frameType(){return state(this).frameType;}
    postMessage(message,options){const info=state(this);if(!arguments.length)throw new TypeError('A message is required');const snapshot=snapshot_message(message,options,encode);void command('client.postMessage',[info.id,snapshot],snapshot.ports).catch(()=>{});}
    get [Symbol.toStringTag](){return 'Client';}
  }
  class WindowClient extends Client{
    get visibilityState(){return state(this).visibilityState;}
    get focused(){return state(this).focused;}
    async navigate(url){
      const info=state(this);if(info.type!=='window')throw new TypeError('Illegal WindowClient receiver');
      if(!arguments.length)throw new TypeError('A navigation URL is required');
      const next=new URL(`${url}`,base);
      if(next.protocol==='about:'&&next.pathname==='blank')throw new TypeError('Cannot navigate to about:blank');
      return source(await command('client.navigate',[info.id,next.href]));
    }
    get [Symbol.toStringTag](){return 'WindowClient';}
  }
  function source(info){
    return info?new (info.type==='window'?WindowClient:Client)(token,info):null;
  }
  const clients=Object.create(null);
  Object.defineProperties(clients,{
    claim:{value:()=>command('clients.claim'),enumerable:true},
    get:{value:async function(id){if(!arguments.length)throw new TypeError('A client ID is required');return source(await command('clients.get',[`${id}`]))||undefined;},enumerable:true},
    matchAll:{value:async(options={})=>{const type=options?.type===undefined?'window':`${options.type}`;if(!['window','worker','sharedworker','all'].includes(type))throw new TypeError('Invalid client type');return (await command('clients.matchAll',[{type,includeUncontrolled:!!options?.includeUncontrolled}])).map(source);},enumerable:true},
    [Symbol.toStringTag]:{value:'Clients'}
  });
  return {Client,WindowClient,clients,source,valid:value=>records.has(value)};
}
