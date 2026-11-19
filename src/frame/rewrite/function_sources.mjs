// Comments preserve native function identity, inferred names and hoisting.
// Keep a single original script plus ranges, rather than copying nested bodies.
export function create_function_sources(records,nonce){
  return {
    register(source,entries){
      if(!entries.length)return [];
      const generation=records.next?records.next('generation'):(records.get('generation')||0)+1;
      if(!records.next)records.set('generation',generation);
      const script={source,generation},prefix=nonce()+'_'+generation;
      return entries.map(({start,end,offset},index)=>{
        const id=prefix+'_'+index;
        records.set(id,{script,start,end});
        return [offset,offset,'/*sandstone-source:'+id+'*/'];
      });
    },
    original(source){
      let selected;
      for(const match of source.matchAll(/\/\*sandstone-source:([a-zA-Z0-9_]+)\*\//g)){
        const entry=records.get(match[1]);
        if(entry&&(!selected||entry.script.generation>selected.script.generation||entry.script.generation===selected.script.generation&&entry.end-entry.start>selected.end-selected.start))selected=entry;
      }
      return selected?selected.script.source.slice(selected.start,selected.end):undefined;
    }
  };
}

export function function_source_entries(ast,source){
  const entries=[];
  function visit(node,parent){
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','ClassExpression'].includes(node.type)){
      let start=node.start,end=node.end;
      if(parent?.value===node&&(parent.type==='MethodDefinition'||parent.type==='Property'&&(parent.method||parent.kind==='get'||parent.kind==='set'))){
        start=parent.start;end=parent.end;
        if(parent.static){
          start+=6;
          // Static is absent from the native method's source text.
          const trivia=/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*/.exec(source.slice(start))[0];
          start+=trivia.length;
        }
      }
      entries.push({start,end,offset:node.body.type==='BlockStatement'||node.body.type==='ClassBody'?node.body.start+1:node.body.start});
    }
    for(const [key,value] of Object.entries(node)){
      if(key==='parent'||key==='path')continue;
      if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child,node);}
      else if(value?.type)visit(value,node);
    }
  }
  visit(ast);return entries;
}
