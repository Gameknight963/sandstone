import {parse} from './javascript_parser.mjs';

// Observe Script completion without introducing a function or lexical scope.
export function instrument_javascript_completion(source,control){
  const ast=parse(source,{ranges:true,webcompat:true,next:true}),edits=[];
  const insert=(offset,text,order=edits.length)=>edits.push({offset,text,order});
  const call=(name,args='')=>control+'.'+name+'('+args+')';
  const reset=()=>call('reset');
  const expression=node=>{insert(node.start,'('+reset()+',');insert(node.end,')');};
  const wrap=node=>{insert(node.start,'if(('+reset()+',true)) ',1e6);insert(node.end,'\nelse ;',-1e6);};
  const empty_for_init=start=>{
    // With no initializer only trivia and the opening parenthesis precede the
    // first semicolon. Comments can themselves contain semicolons.
    for(let index=start;index<source.length;index++){
      if(source.startsWith('/*',index)){index=source.indexOf('*/',index+2)+1;continue;}
      if(source.startsWith('//',index)){while(index<source.length&&!/[\r\n\u2028\u2029]/.test(source[index]))index++;continue;}
      if(source[index]===';')return index;
    }
  };
  let finally_id=0;
  const visit=(node,parent)=>{
    if(!node||typeof node!=='object')return;
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','ClassExpression'].includes(node.type))return;
    if(node.type==='ExpressionStatement'){
      if(node.directive===undefined){insert(node.expression.start,control+'.complete((');insert(node.expression.end,'))');}
      return;
    }
    if(node.type==='IfStatement')expression(node.test);
    if(node.type==='SwitchStatement')expression(node.discriminant);
    if(node.type==='WithStatement')expression(node.object);
    if(node.type==='ForStatement'){
      if(!node.init)insert(empty_for_init(node.start),reset());
      else if(node.init.type==='VariableDeclaration')insert(node.init.declarations[0].start,'{}=('+reset()+',0),');
      else expression(node.init);
    }
    if(node.type==='ForInStatement'||node.type==='ForOfStatement')expression(node.right);
    if((node.type==='WhileStatement'||node.type==='DoWhileStatement')&&parent?.type!=='LabeledStatement')wrap(node);
    if(node.type==='LabeledStatement'&&parent?.type!=='LabeledStatement'){
      let body=node.body;while(body.type==='LabeledStatement')body=body.body;
      if(body.type==='WhileStatement'||body.type==='DoWhileStatement')wrap(node);
    }
    if(node.type==='TryStatement'){
      insert(node.block.start+1,reset()+';',1e6);
      if(node.handler)insert(node.handler.body.start+1,reset()+';',1e6);
      if(node.finalizer){
        const id=finally_id++;
        insert(node.finalizer.start+1,call('finallyBegin',id)+';',1e6);
        insert(node.finalizer.end-1,';'+call('finallyEnd',id)+';',-1e6);
      }
    }
    for(const value of Object.values(node)){
      if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child,node);}
      else if(value?.type)visit(value,node);
    }
  };
  visit(ast);
  const first=ast.body.find(statement=>statement.directive===undefined),offset=first?.start??source.length;
  const last=ast.body.filter(statement=>statement.directive!==undefined).at(-1);
  // Insert begin last so it precedes other edits at the same position.
  insert(offset,'\n'+call('begin',last?JSON.stringify(last.expression.value):'')+';',1e9);
  insert(source.length,'\n;'+call('done')+';',-1e9);
  edits.sort((a,b)=>b.offset-a.offset||a.order-b.order);
  for(const {offset,text} of edits)source=source.slice(0,offset)+text+source.slice(offset);
  return source;
}

export function create_javascript_completion(){
  let value,completed=false;
  const finalizers=new Map();
  return Object.freeze({
    begin(initial){value=initial;completed=false;finalizers.clear();},
    complete(next){value=next;return next;},
    reset(){value=undefined;},
    finallyBegin(id){finalizers.set(id,value);value=undefined;},
    finallyEnd(id){value=finalizers.get(id);finalizers.delete(id);},
    done(){completed=true;},
    result(){return {completed,value};}
  });
}
