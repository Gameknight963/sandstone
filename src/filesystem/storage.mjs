import {IDBFactory} from 'fake-indexeddb';

const name='sandstone:filesystem:v1';
const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
export class FileStorage{
  constructor(factory,{onCatalog=()=>{}}={}){this.persistent=!!factory;this.onCatalog=onCatalog;this.ready=this.open(factory);}
  async open(factory){
    const connect=factory=>new Promise((resolve,reject)=>{
      let abandoned=false;const open=factory.open(name,2);
      open.onupgradeneeded=()=>{
        const db=open.result;
        if(!db.objectStoreNames.contains('nodes'))db.createObjectStore('nodes',{keyPath:['origin','id']}).createIndex('origin','origin');
        if(!db.objectStoreNames.contains('bytes'))db.createObjectStore('bytes',{keyPath:['origin','id']}).createIndex('origin','origin');
        if(!db.objectStoreNames.contains('capabilities'))db.createObjectStore('capabilities',{keyPath:['origin','locator']}).createIndex('origin','origin');
      };
      open.onerror=()=>reject(open.error);
      open.onblocked=()=>{abandoned=true;reject(new DOMException('File storage is blocked','InvalidStateError'));};
      open.onsuccess=()=>{if(abandoned)open.result.close();else{open.result.onversionchange=()=>open.result.close();resolve(open.result);}};
    });
    try{if(factory)this.db=await connect(factory);}catch{}
    if(!this.db){this.persistent=false;this.db=await connect(new IDBFactory());}
  }
  async run(origin,write,action){
    await this.ready;
    return new Promise((resolve,reject)=>{
      const tx=this.db.transaction(['nodes','bytes','capabilities'],write?'readwrite':'readonly'),nodes=tx.objectStore('nodes'),bytes=tx.objectStore('bytes'),caps=tx.objectStore('capabilities');let result,failure;
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||tx.error||new DOMException('File operation aborted','AbortError'));
      (async()=>{
        const [entries,grants]=await Promise.all([request(nodes.index('origin').getAll(origin)),request(caps.index('origin').getAll(origin))]),tree=new Map(entries.map(node=>[node.id,node])),capabilities=new Map(grants.map(value=>[value.locator,value.token]));
        const path=node=>node.path??(node.path=node.parent===null?[]:[...path(tree.get(node.parent)),node.name]);
        for(const node of entries)path(node);
        result=await action({tree,capabilities,grant:(locator,token)=>{capabilities.set(locator,token);caps.put({origin,locator,token});},revoke:()=>{for(const locator of capabilities.keys())caps.delete([origin,locator]);capabilities.clear();},put:node=>{tree.set(node.id,node);nodes.put(node);},remove:id=>{tree.delete(id);nodes.delete([origin,id]);bytes.delete([origin,id]);},read:id=>request(bytes.get([origin,id])).then(value=>value?.bytes||new Uint8Array()),write:(id,value)=>bytes.put({origin,id,bytes:value})});
      })().catch(error=>{failure=error;try{tx.abort();}catch{reject(error);}});
    });
  }
  async catalog(){
    await this.ready;
    const entries=await request(this.db.transaction('nodes').objectStore('nodes').getAll()),origins=new Map();
    for(const node of entries){let info=origins.get(node.origin);if(!info)origins.set(node.origin,info={origin:node.origin,files:0,usage:0});if(node.kind==='file'){info.files++;info.usage+=node.size||0;}}
    const result=[...origins.values()];this.onCatalog(result);return result;
  }
  async clear(hostname){
    for(const {origin} of await this.catalog()){
      const host=new URL(origin).hostname;if(hostname&&host!==hostname)continue;
      await this.run(origin,true,({tree,remove,revoke})=>{for(const id of tree.keys())remove(id);revoke();});
    }
    await this.catalog();
  }
}
