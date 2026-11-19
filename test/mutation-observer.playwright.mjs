import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

export async function verifyMutationQueues(page){
  // Exercise the production adapter with real browser queues. Document aliases
  // are covered separately; this isolated registry only supplies their maps.
  const source=(await readFile(new URL('../src/frame/intercept/mutation_observer.mjs',import.meta.url),'utf8'))
    .replace(/^import[^\n]*\n/,'').replaceAll('export ','');
  const control=await page.context().newPage();
  try{
    const results=await control.evaluate(async source=>{
      const Native=MutationObserver,maps=new Map();
      const states=(name,{weak=true}={})=>{if(!maps.has(name))maps.set(name,weak?new WeakMap():new Map());return maps.get(name);};
      const adapter=Function('document_states','unwrap_document',source+';return {MutationObserver,internal_attribute_mutation};')(states,value=>value);
      const cases=['empty','pending records','takeRecords','disconnect','reobserve','nested writes','takeRecords during write','throwing write','observer ordering'];
      const results=[];
      for(const name of cases){
        const outcomes=[];
        for(const virtual of [false,true]){
          const root=document.createElement('div'),audio=document.createElement('audio');root.append(audio);document.body.append(root);
          const log=[],observers=[],Ctor=virtual?adapter.MutationObserver:Native;
          const summarize=list=>list.map(record=>({type:record.type,target:record.target===root?'root':'audio',name:record.attributeName,old:record.oldValue,added:record.addedNodes.length}));
          const observer=new Ctor(list=>log.push(['callback',summarize(list)]));observers.push(observer);
          observer.observe(root,{attributes:true,attributeOldValue:true,childList:true,subtree:true});
          if(name==='observer ordering'){
            const second=new Ctor(list=>log.push(['second',summarize(list)]));second.observe(root,{attributes:true,attributeOldValue:true,subtree:true});observers.push(second);
          }
          const internal=operation=>virtual?adapter.internal_attribute_mutation(audio,'src',operation):operation();
          const renderer=()=>{if(virtual){audio.setAttribute('src','data:audio/wav,');audio.removeAttribute('src');}};
          if(name!=='empty')root.setAttribute('data-before','1');
          Promise.resolve().then(()=>log.push(['microtask']));
          try{internal(()=>{
            renderer();
            if(name==='nested writes')internal(renderer);
            if(name==='takeRecords during write')log.push(['taken',summarize(observer.takeRecords())]);
            if(name==='throwing write')throw new Error('authored failure');
          });}catch(error){log.push(['throw',error.message]);}
          if(name==='takeRecords')log.push(['taken',summarize(observer.takeRecords())]);
          if(name==='disconnect'||name==='reobserve')observer.disconnect();
          if(name==='reobserve')observer.observe(audio,{attributes:true,attributeFilter:['data-after'],attributeOldValue:true});
          if(name!=='empty'){
            audio.setAttribute('data-after','2');root.append(document.createTextNode('child'));
          }
          await new Promise(resolve=>setTimeout(resolve,0));
          log.push(['remaining',summarize(observer.takeRecords())]);
          for(const entry of observers)entry.disconnect();root.remove();outcomes.push(log);
        }
        results.push({name,native:outcomes[0],virtual:outcomes[1]});
      }
      {
        const node=document.createElement('audio'),observer=new adapter.MutationObserver(()=>{});
        observer.observe(node,{attributes:true});node.setAttribute('data-authored','1');
        adapter.internal_attribute_mutation(node,'src',()=>{node.setAttribute('src','data:audio/wav,');node.removeAttribute('src');});
        globalThis.queueObserverReference=new WeakRef(observer);
      }
      await new Promise(resolve=>setTimeout(resolve,0));
      return results;
    },source);
    for(const result of results)assert.deepEqual(result.virtual,result.native,'MutationObserver '+result.name);
    await control.requestGC();
    assert.equal(await control.evaluate(()=>queueObserverReference.deref()===undefined),true,'Observer registry retained a detached observer');
    return [...results.map(result=>'MutationObserver renderer filtering: '+result.name),'MutationObserver renderer filtering: detached observers can be collected'];
  }finally{await control.close();}
}
