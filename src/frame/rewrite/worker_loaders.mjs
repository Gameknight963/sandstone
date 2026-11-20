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
  function visit(node){if(node.type==='MethodDefinition')method(node);children(node,visit);}
  visit(ast);return result;
}
