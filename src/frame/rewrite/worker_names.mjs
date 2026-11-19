import {parse} from '../javascript_parser.mjs';

function children(node,visit){
  for(const [key,value] of Object.entries(node)){
    if(key==='parent'||key==='path')continue;
    if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}
    else if(value?.type)visit(value);
  }
}
function insert(source,edits){
  edits.sort((a,b)=>a[0]-b[0]||(a[2]||0)-(b[2]||0)||(a[3]||0)-(b[3]||0));
  let offset=0,result='';
  for(const [at,text] of edits){result+=source.slice(offset,at)+text;offset=at;}
  return result+source.slice(offset);
}
function inferred_name(node,parent){
  if(parent?.type==='VariableDeclarator'&&parent.init===node&&parent.id.type==='Identifier')return parent.id.name;
  if((parent?.type==='AssignmentPattern'||parent?.type==='AssignmentExpression'&&['=','||=','&&=','??='].includes(parent.operator))&&parent.right===node&&parent.left.type==='Identifier')return parent.left.name;
  if(parent?.type==='ExportDefaultDeclaration')return 'default';
  // Native property/field evaluation already derives names from the key,
  // including computed Symbols. Never evaluate or coerce that key again.
  if(['Property','MethodDefinition','PropertyDefinition','FieldDefinition'].includes(parent?.type)&&parent.value===node)return null;
  return '';
}

export class WorkerNames{
  constructor(sources){
    const text=sources.join('\n'),identifiers=new Set();
    const collect=node=>{if(node.type==='Identifier')identifiers.add(node.name);children(node,collect);};
    for(const source of sources)collect(parse(source,{module:true,next:true}));
    this.alias='__sandstone_worker_names__';
    while(text.includes(this.alias)||identifiers.has(this.alias))this.alias+='_';
    this.contextAlias='__sandstone_worker_context__';
    while(text.includes(this.contextAlias)||identifiers.has(this.contextAlias))this.contextAlias+='_';
    this.marker='sandstone-worker-name:';
    while(text.includes(this.marker))this.marker+='_';
    this.names=new Map();
  }
  prepare(source){
    const ast=parse(source,{module:true,ranges:true,next:true}),edits=[];
    const wrap=(node,name)=>{
      edits.push([node.start,'({['+JSON.stringify(name)+']:(',2,-node.end]);
      edits.push([node.end,')})['+JSON.stringify(name)+']'+(node.type==='ClassDeclaration'?';':''),0,-node.start]);
    };
    const visit=(node,parent)=>{
      if(node.type==='FunctionDeclaration'){
        const name=node.id?.name??(parent?.type==='ExportDefaultDeclaration'?'default':undefined);
        if(name!==undefined){const id=this.names.size;this.names.set(String(id),name);edits.push([node.body.start+1,'/*'+this.marker+id+'*/',1]);}
      }else if(node.type==='FunctionExpression'&&node.id){
        edits.push([node.start,this.alias+'.setName((',2,-node.end]);
        edits.push([node.end,'),'+JSON.stringify(node.id.name)+')',0,-node.start]);
      }else if(['FunctionExpression','ArrowFunctionExpression','ClassExpression','ClassDeclaration'].includes(node.type)&&!node.id){
        const name=inferred_name(node,parent);if(name!==null)wrap(node,name);
      }
      children(node,child=>visit(child,node));
    };
    visit(ast);return insert(source,edits);
  }
  finish(source,contextURL){
    const ast=parse(source,{module:true,ranges:true,next:true}),scopes=new Map(),edits=[];
    const marker=new RegExp('^\\s*/\\*'+this.marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(\\d+)\\*/');
    const visit=(node,scope)=>{
      if(node.type==='FunctionDeclaration'&&node.id){
        const match=marker.exec(source.slice(node.body.start+1,node.body.end-1));
        if(match&&this.names.has(match[1])&&node.id.name!==this.names.get(match[1])){
          let names=scopes.get(scope);if(!names)scopes.set(scope,names=[]);
          names.push(this.alias+'.setName('+node.id.name+','+JSON.stringify(this.names.get(match[1]))+');');
        }
      }
      const owner=['Program','BlockStatement','StaticBlock','SwitchStatement'].includes(node.type)?node:scope;
      children(node,child=>visit(child,owner));
    };
    visit(ast,ast);
    const start=owner=>owner.body.find(statement=>statement.directive===undefined)?.start??owner.end;
    for(const [scope,names] of scopes){
      if(scope.type==='SwitchStatement'){
        // Case declarations are initialized before case tests, but after the
        // discriminant. A fresh private Symbol can never match that value.
        edits.push([scope.cases[0].start,'case ('+names.map(name=>name.slice(0,-1)).join(',')+','+this.alias+'.Symbol()):',1]);
      }else edits.push([start(scope),names.join(''),1]);
    }
    const context=contextURL?'import '+this.contextAlias+' from '+JSON.stringify(contextURL)+';':'const '+this.contextAlias+'=__ctx__;';
    edits.push([start(ast),context+'const '+this.alias+'='+this.contextAlias+'.__module_intrinsics__;',0]);
    return insert(source,edits);
  }
}
