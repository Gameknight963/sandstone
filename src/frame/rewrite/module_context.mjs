import {parse} from '../javascript_parser.mjs';

export function module_context_name(source){
  const identifiers=new Set();
  const visit=node=>{
    if(node.type==='Identifier')identifiers.add(node.name);
    for(const [key,value] of Object.entries(node)){
      if(key==='parent'||key==='path')continue;
      if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}
      else if(value?.type)visit(value);
    }
  };
  visit(parse(source,{module:true,next:true}));
  let name='__sandstone_module_context__';
  while(source.includes(name)||identifiers.has(name))name+='_';
  return name;
}
