const member=node=>node?.type==='MemberExpression'?(node.computed?node.property.value:node.property.name):undefined;
const call=(node,name,args)=>node?.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name===name&&(!args||node.arguments.length===args.length&&node.arguments.every((value,index)=>value.type==='Identifier'&&value.name===args[index]));

// AMD's worker script transport already has success/error callbacks and an
// asynchronous fetch branch. Adapt that transport, never arbitrary synchronous
// importScripts calls or a worker's own message protocol.
export function worker_loader_imports(ast){
  const result=[];
  function children(node,visit){
    for(const value of Object.values(node)){
      if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}
      else if(value?.type)visit(value);
    }
  }
  const parents=new WeakMap(),variables=new WeakMap();
  (function index(node){children(node,child=>{parents.set(child,node);index(child);});})(ast);
  const functions=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
  function pattern(node,name){
    if(!node)return;
    if(node.type==='Identifier')return node.name===name?node:undefined;
    if(node.type==='RestElement')return pattern(node.argument,name);
    if(node.type==='AssignmentPattern')return pattern(node.left,name);
    if(node.type==='ArrayPattern')for(const entry of node.elements){const found=pattern(entry,name);if(found)return found;}
    if(node.type==='ObjectPattern')for(const entry of node.properties){const found=pattern(entry.type==='RestElement'?entry.argument:entry.value,name);if(found)return found;}
  }
  function binding(node,name){
    for(let scope=parents.get(node);scope;scope=parents.get(scope)){
      if(functions.has(scope.type)){
        for(const parameter of scope.params){const found=pattern(parameter,name);if(found)return {owner:scope,node:found,kind:'parameter'};}
        if(scope.id?.name===name)return {owner:scope,node:scope.id,kind:'function'};
      }
      const body=scope.type==='Program'||scope.type==='BlockStatement'?scope.body:scope.type==='SwitchStatement'?scope.cases.flatMap(entry=>entry.consequent):[];
      const loop=['ForStatement','ForInStatement','ForOfStatement'].includes(scope.type)?[scope.init||scope.left].filter(entry=>entry?.type==='VariableDeclaration'):[];
      const declarations=[...body.filter(entry=>entry.type==='VariableDeclaration'),...loop];
      for(const declaration of declarations)if(declaration.kind!=='var')for(const entry of declaration.declarations){
        const found=pattern(entry.id,name);if(found)return {owner:scope,node:found,kind:declaration.kind,end:declaration.end};
      }
      if(scope.type==='CatchClause'){const found=pattern(scope.param,name);if(found)return {owner:scope,node:found,kind:'catch'};}
      if(scope.type==='Program'||functions.has(scope.type)){
        let names=variables.get(scope);
        if(!names){
          names=new Map();variables.set(scope,names);
          const scan=value=>{
            if(functions.has(value.type)||['ClassDeclaration','ClassExpression'].includes(value.type))return;
            if(value.type==='VariableDeclaration'&&value.kind==='var')for(const entry of value.declarations){
              const collect=value=>{
                if(value?.type==='Identifier')names.set(value.name,value);
                else if(value?.type==='RestElement')collect(value.argument);
                else if(value?.type==='AssignmentPattern')collect(value.left);
                else if(value?.type==='ArrayPattern')value.elements.forEach(collect);
                else if(value?.type==='ObjectPattern')value.properties.forEach(entry=>collect(entry.type==='RestElement'?entry.argument:entry.value));
              };collect(entry.id);
            }
            children(value,scan);
          };
          scan(scope.type==='Program'?scope:scope.body);
        }
        if(names.has(name))return {owner:scope,node:names.get(name),kind:'var'};
      }
    }
  }
  function method(node){
    const fn=node.value;if(node.computed||node.key?.name!=='load'||fn?.async||fn?.generator||fn?.params.length!==4||fn.params.some(param=>param.type!=='Identifier'))return;
    const [manager,url,loaded,failed]=fn.params.map(param=>param.name);let configured=false;
    function scan(value){
      if(value!==fn.body&&['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','ClassExpression'].includes(value.type))return;
      if(value.type==='CallExpression'&&member(value.callee)==='getOptionsLiteral'&&value.callee.object.type==='CallExpression'&&member(value.callee.object.callee)==='getConfig'&&value.callee.object.callee.object.type==='Identifier'&&value.callee.object.callee.object.name===manager)configured=true;
      children(value,scan);
    }
    scan(fn.body);if(!configured)return;
    function find(value){
      if(value!==fn.body&&['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','ClassExpression'].includes(value.type))return;
      if(value.type==='TryStatement'&&!value.finalizer&&value.handler?.param?.type==='Identifier'){
        const error=value.handler.body.body;
        if(error.length===1&&error[0].type==='ExpressionStatement'&&call(error[0].expression,failed,[value.handler.param.name])){
          const statements=value.block.body,last=statements.at(-1);let imported,callback,start,end;
          if(last?.type==='ExpressionStatement'&&last.expression.type==='SequenceExpression'){
            const expressions=last.expression.expressions;imported=expressions.at(-2);callback=expressions.at(-1);start=imported?.start;end=callback?.end;
          }else if(statements.length>=2&&last?.type==='ExpressionStatement'&&statements.at(-2).type==='ExpressionStatement'){
            imported=statements.at(-2).expression;callback=last.expression;start=statements.at(-2).start;end=last.end;
          }
          if(call(imported,'importScripts',[url])&&call(callback,loaded,[]))result.push({imported,callback,start,end,url,loaded,failed,failedReference:error[0].expression.callee,statement:last.expression.type!=='SequenceExpression'});
        }
      }
      children(value,find);
    }
    find(fn.body);
  }
  function promise(node){
    if(node.type!=='NewExpression'||node.callee.type!=='Identifier'||node.callee.name!=='Promise'||node.arguments.length!==1)return;
    const fn=node.arguments[0];if(!['ArrowFunctionExpression','FunctionExpression'].includes(fn.type)||fn.async||fn.generator||fn.body.type!=='BlockStatement'||fn.params.length<1||fn.params.length>2||fn.params.some(param=>param.type!=='Identifier'))return;
    if(fn.params.length===1&&fn.body.body.some(statement=>statement.directive==='use strict'))return;
    // Rollup-style AMD transports select a DOM script loader or a worker
    // import inside the same Promise. Delay the metadata assignment together
    // with importScripts so overlapping loads cannot register under another URL.
    function find(value){
      if(value!==fn.body&&['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','ClassExpression'].includes(value.type))return;
      const test=value.type==='IfStatement'&&value.test;
      if(test?.type==='BinaryExpression'&&test.operator==='in'&&test.left.type==='Literal'&&test.left.value==='document'&&test.right.type==='Identifier'&&['self','globalThis'].includes(test.right.name)){
        const branch=value.alternate,expression=branch?.type==='ExpressionStatement'?branch.expression:branch?.type==='BlockStatement'&&branch.body.length===1&&branch.body[0].type==='ExpressionStatement'?branch.body[0].expression:null;
        const parts=expression?.type==='SequenceExpression'&&expression.expressions;
        if(parts?.length===3){
          const [metadata,imported,callback]=parts,loaded=fn.params[0].name,url=imported?.arguments?.[0];
          if(metadata.type==='AssignmentExpression'&&metadata.operator==='='){
            const target=metadata.left,owner=target.type==='Identifier'&&binding(target,target.name);
            const lexical=owner&&!['const','function'].includes(owner.kind)&&owner.owner!==fn&&!(owner.kind==='let'&&owner.end>node.start);
            const property=target.type==='MemberExpression'&&target.object.type==='Identifier'&&target.object.name===test.right.name;
            if((property||lexical)&&binding(callback.callee,loaded)?.node===fn.params[0]&&metadata.right.type==='Identifier'&&url?.type==='Identifier'&&metadata.right.name===url.name&&call(imported,'importScripts',[url.name])&&call(callback,loaded,[]))result.push({promise:node,executor:fn,metadata,imported,callback,url:url.name,loaded,failed:fn.params[1]?.name,global:test.right});
          }
        }
      }
      children(value,find);
    }
    find(fn.body);
  }
  function visit(node){if(node.type==='MethodDefinition')method(node);promise(node);children(node,visit);}
  visit(ast);return result;
}

// Discovery can omit these asynchronous transports only when their native
// names are unshadowed. Be conservative across the entire script: a local
// binding or dynamic lexical scope keeps the ordinary discovery path intact.
export function asynchronous_worker_imports(ast){
  const reserved=new Set(['Promise','importScripts','self','globalThis']);let unsafe=false;
  function binding(node){if(!node?.type)return;if(node.type==='Identifier'&&reserved.has(node.name))unsafe=true;else for(const value of Object.values(node))if(Array.isArray(value))value.forEach(binding);else if(value?.type)binding(value);}
  function walk(node){
    if(node.type==='WithStatement'||node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='eval')unsafe=true;
    if(node.type==='VariableDeclarator')binding(node.id);
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)){binding(node.id);node.params.forEach(binding);}
    if(node.type==='ClassDeclaration'||node.type==='ClassExpression')binding(node.id);
    if(node.type==='CatchClause')binding(node.param);
    for(const value of Object.values(node))if(Array.isArray(value)){for(const child of value)if(child?.type)walk(child);}else if(value?.type)walk(value);
  }
  walk(ast);return unsafe?new Set():new Set(worker_loader_imports(ast).filter(entry=>entry.promise).map(entry=>entry.imported));
}
