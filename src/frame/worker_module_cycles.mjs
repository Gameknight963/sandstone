import {parse} from './javascript_parser.mjs';
import {rewrite_source} from './rewrite/javascript.mjs';

// Compile only unresolved worker graphs. Each record is an entry, so Rollup
// emits native ESM facades for later imports of any member of the cycle.
export async function compile_worker_cycles(entry,records,loader,rollup){
  const byId=new Map([...records].map(record=>[record.nativeKey,record]));
  const input=Object.fromEntries([...records].map((record,index)=>['entry'+index,record.nativeKey]));
  const namespaceIds=new Map([...records].map(record=>[record.nativeKey+':namespace',record]));
  for(const [index,id] of [...namespaceIds.keys()].entries())input['namespace'+index]=id;
  const bundle=await rollup({
    input,treeshake:false,preserveEntrySignatures:'strict',
    // Native-valid directives and cycles can generate compiler warnings.
    // Syntax/link failures still reject through Rollup's error path.
    onwarn(){},
    plugins:[{
      name:'sandstone-worker-graph',
      resolveId(id){
        if(byId.has(id)||namespaceIds.has(id))return id;
        if([...loader.records.values()].some(record=>record.blob===id||record.namespaceBlob===id))return {id,external:true};
        throw new TypeError('Unknown worker module dependency: '+id);
      },
      load(id){
        if(namespaceIds.has(id))return 'export * as namespace from '+JSON.stringify(namespaceIds.get(id).nativeKey)+';';
        const record=byId.get(id);
        if(!record)throw new TypeError('Unknown worker module: '+id);
        if(record.type==='json')return 'export default __ctx__.__json_module__('+JSON.stringify(record.source)+');';
        if(record.type!=='javascript')throw new TypeError('Unsupported worker module type: '+record.type);
        const rewritten=loader.rewrite(record.source,{
          module:true,url:record.url,importReferrer:{key:record.key},stripAttributes:true,
          resolveNamespace:specifier=>loader.records.get(loader.map.resolve(specifier,record.url))?.namespaceBlob,
          resolve(specifier){const dependency=loader.records.get(loader.map.resolve(specifier,record.url));return dependency.blob||dependency.nativeKey;}
        });
        // Distinguish authored built-in references from helpers the compiler
        // will add later. Public Object.freeze must retain native semantics.
        return rewrite_source(rewritten,['Object','Symbol'],{module:true,contextName:'__ctx__',globalName:'__ctx__.__globals__',rewriteThis:false});
      }
    }]
  });
  try{
    const {output}=await bundle.generate({format:'es',entryFileNames:'[name].js',chunkFileNames:'chunk-[hash].js',minifyInternalExports:false,generatedCode:{symbols:true}});
    const chunks=new Map(output.filter(item=>item.type==='chunk').map(chunk=>[chunk.fileName,chunk]));
    if(chunks.size!==output.length)throw new TypeError('Unexpected worker module asset');
    const urls=new Map(),pending=new Set(chunks.keys());
    while(pending.size){
      let progressed=false;
      for(const name of pending){
        const chunk=chunks.get(name);
        if(chunk.imports.some(id=>chunks.has(id)&&!urls.has(id)))continue;
        const ast=parse(chunk.code,{module:true,ranges:true,next:true}),edits=[];
        for(const node of ast.body){
          if(!node.source)continue;
          const id=node.source.value.replace(/^\.\//,'');
          if(chunks.has(id))edits.push([node.source.start,node.source.end,JSON.stringify(urls.get(id))]);
        }
        let source=chunk.code;
        for(const [start,end,text] of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,start)+text+source.slice(end);
        // Compiler namespace helpers must retain native built-ins even when a
        // classic worker has published replacement Object/Symbol globals.
        source=rewrite_source(source,['Object','Symbol'],{module:true,contextName:'__ctx__.__module_intrinsics__',rewriteThis:false});
        if(loader.preamble)source=loader.preamble+'\n'+source;
        const record=byId.get(chunk.facadeModuleId),label=record?.url||entry.url;
        source+='\n//# sourceURL='+label.replace(/[\r\n\u2028\u2029]/g,'')+'\n';
        urls.set(name,loader.createURL(source,'text/javascript',label));pending.delete(name);progressed=true;
      }
      if(!progressed)throw new TypeError('Worker compiler emitted a cyclic chunk graph');
    }
    // Commit atomically: a failed graph cannot leave apparently usable records.
    const prepared=new Map(),namespaces=new Map();
    for(const chunk of chunks.values()){
      if(byId.has(chunk.facadeModuleId))prepared.set(byId.get(chunk.facadeModuleId),urls.get(chunk.fileName));
      if(namespaceIds.has(chunk.facadeModuleId))namespaces.set(namespaceIds.get(chunk.facadeModuleId),urls.get(chunk.fileName));
    }
    if([...records].some(record=>!prepared.has(record)||!namespaces.has(record)))throw new TypeError('Worker compiler omitted a module entry');
    for(const [record,url] of prepared){record.blob=url;record.namespaceBlob=namespaces.get(record);}
    return entry;
  }finally{await bundle.close();}
}
