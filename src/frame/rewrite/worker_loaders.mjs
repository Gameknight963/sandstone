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
          if(metadata.type==='AssignmentExpression'&&metadata.operator==='='&&metadata.left.type==='MemberExpression'&&metadata.left.object.type==='Identifier'&&metadata.left.object.name===test.right.name&&metadata.right.type==='Identifier'&&url?.type==='Identifier'&&metadata.right.name===url.name&&call(imported,'importScripts',[url.name])&&call(callback,loaded,[]))result.push({promise:node,executor:fn,metadata,imported,callback,url:url.name,loaded,failed:fn.params[1]?.name,global:test.right});
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
