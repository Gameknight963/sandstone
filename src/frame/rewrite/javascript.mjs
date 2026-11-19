import { parse } from "../javascript_parser.mjs";
import {function_source_entries} from './function_sources.mjs';
import {static_module_type} from '../module_attributes.mjs';
const terminated_nodes=new Set(['ExpressionStatement','VariableDeclaration','ReturnStatement','ThrowStatement','BreakStatement','ContinueStatement','DebuggerStatement','DoWhileStatement','PropertyDefinition','FieldDefinition']);

class Scope {
  constructor(parent, kind) { this.parent = parent; this.kind = kind; this.names = new Set(); this.lexical=new Set();this.strict=parent?.strict??false; }
  has(name) { return this.names.has(name) || !!this.parent?.has(name); }
  owner(name) { return this.names.has(name)?this:this.parent?.owner(name); }
  variable() { return this.kind === "function" || !this.parent ? this : this.parent.variable(); }
}

function children(node, callback) {
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "path") continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) callback(child, key);
    } else if (value?.type) callback(value, key);
  }
}

export function rewrite_source(source, globals, {module = false, url,importReferrer=url, resolve,resolveNamespace, stripAttributes = false, sourceURL, contextName='__ctx__',globalName=contextName,thisName='__get_this__',withContext='(function(){return this})().__ctx__',dynamicImport=false,preserveWith=false,preserveDirectEval=false,preserveGlobalScope=false,evalMode=false,functionSources,rewriteThis=true,directEval=false,evalContext} = {}) {
  const runtimeContext=evalContext?.withToken?evalContext.withToken+'.context':contextName;
  let named=false;
  const onComment=sourceURL?(type,text)=>{
    if(type==='SingleLine'&&/^[#@]\s+sourceURL=\s*\S+\s*$/.test(text))named=true;
  }:undefined;
  let ast;
  if(evalContext){
    // Parse the caller's contextual grammar without executing a wrapper.
    // Native eval still validates the extracted Script in its real environment.
    const prefix=evalContext.strict?'class __Eval__ extends Object {'+(evalContext.privateNames||[]).map(name=>'#'+name+';').join('')+'constructor(){':'function __Eval__(){';
    const wrapper=parse(prefix+source+'\n}'+(evalContext.strict?'}':''),{ranges:true,webcompat:true,next:true,onComment});
    const body=evalContext.strict?wrapper.body[0].body.body.at(-1).value.body.body:wrapper.body[0].body.body;
    const shift=node=>{node.start-=prefix.length;node.end-=prefix.length;if(node.range)node.range=[node.start,node.end];children(node,shift);};
    body.forEach(shift);ast={type:'Program',start:0,end:source.length,body};
  }else ast=parse(source, {ranges: true, webcompat: true, module, next: true, onComment});
  const scopes = new WeakMap();
  const bindings = new WeakSet();
  const bindingScopes=new WeakMap(),withScopes=new WeakMap(),namedEvalDeclarations=new WeakSet();
  const names = new Set(globals.filter(name=>!evalContext?.locals?.includes(name)));
  const edits = functionSources?functionSources.register(source,function_source_entries(ast,source)):[];
  const functionBodies=new WeakSet(),legacyFunctions=[],globalFunctions=new Set(),globalVariables=new Set(),declarations=[],identifiers=new Set(),privateNames=new Set(evalContext?.privateNames);
  const strictBody=node=>Array.isArray(node?.body)&&node.body.some(statement=>statement.directive==='use strict');
  const functionScopes=new WeakMap();
  const evalIdentifiers=new WeakMap();
  const containsEval=node=>{
    if(evalIdentifiers.has(node))return evalIdentifiers.get(node);
    let found=node.type==='Identifier'&&node.name==='eval';
    children(node,child=>{found=containsEval(child)||found;});
    evalIdentifiers.set(node,found);return found;
  };
  const untouchedAsm=node=>node?.type==='BlockStatement'&&node.body[0]?.directive==='use asm'&&!containsEval(node);

  function bind(pattern, scope, lexical=false) {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      scope.names.add(pattern.name);
      if(lexical)scope.lexical.add(pattern.name);
      bindings.add(pattern);
      bindingScopes.set(pattern,scope);
    } else if (pattern.type === "AssignmentPattern") bind(pattern.left, scope,lexical);
    else if (pattern.type === "RestElement") bind(pattern.argument, scope,lexical);
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(element => bind(element, scope,lexical));
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach(property => bind(property.type === "RestElement" ? property.argument : property.value, scope,lexical));
  }

  function build(node, scope,parent) {
    if(node.type==='Identifier')identifiers.add(node.name);
    if(node.type==='PrivateIdentifier')privateNames.add(node.name);
    if (node.type === "FunctionDeclaration") {
      // Annex B treats unbraced if arms as implicit lexical blocks.
      if(parent?.type==='IfStatement'){scope=new Scope(scope,"block");scope.container=node;}
      const block=scope.kind!=="function"&&!scope.body;
      bind(node.id,block?scope:scope.variable(),block&&(node.async||node.generator));
      if(!module&&!block&&node.id&&scope.variable()===root&&names.has(node.id.name))globalFunctions.add(node.id.name);
      if(block&&!scope.strict&&!node.async&&!node.generator&&names.has(node.id.name))legacyFunctions.push({node,scope,implicit:parent?.type==='IfStatement'});
    }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      // Parameter initializers run outside the body's variable environment.
      // Closures created there must not capture a later body var/function.
      scope = new Scope(scope, "block");
      scope.parameterScope=true;
      scope.strict ||= strictBody(node.body);
      if (node.type === "FunctionExpression") bind(node.id, scope);
      node.params.forEach(param => bind(param, scope));
      scopes.set(node,scope);
      const bodyScope=new Scope(scope,"function");
      bodyScope.bodyNode=node.body;
      bodyScope.container=node.body;
      bodyScope.functionNode=node;
      functionScopes.set(node,bodyScope);
      bodyScope.parameters=scope.names;
      if(untouchedAsm(node.body)){
        scope.preserveEval=true;bodyScope.preserveEval=true;
        if(node.id?.name==='eval')bindingScopes.get(node.id).preserveEval=true;
      }
      if(node.body.type==='BlockStatement')functionBodies.add(node.body);
      children(node,(child,key)=>build(child,key==='body'?bodyScope:scope,node));
      return;
    } else if(node.type==='WithStatement'){
      scopes.set(node,scope);build(node.object,scope,node);
      const environment=new Scope(scope,'with');withScopes.set(node,environment);
      build(node.body,environment,node);return;
    } else if(node.type==='StaticBlock'){
      // A class static block owns both its lexical and var declarations.
      // Neither may suppress global rewriting in other fields or outer code.
      scope=new Scope(scope,"function");
    } else if(node.type==='SwitchStatement'){
      scopes.set(node,scope);
      build(node.discriminant,scope,node);
      // The discriminant precedes the shared lexical environment of all cases.
      const caseScope=new Scope(scope,"block");
      caseScope.container=node;
      node.cases.forEach(branch=>build(branch,caseScope,node));
      return;
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.type === "ClassDeclaration") bind(node.id, scope,true);
      scope = new Scope(scope, "block");
      scope.container=node;
      scope.strict=true;
      bind(node.id, scope,true);
    } else if (["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement"].includes(node.type)) {
      scope = new Scope(scope, "block");
      scope.container=node;
      if(functionBodies.has(node))scope.body=true;
      // Legacy var declarations may cross a simple catch parameter, but not
      // a destructuring catch binding or other intervening lexical bindings.
      if (node.type === "CatchClause") bind(node.param, scope,node.param?.type!=='Identifier');
    }
    scopes.set(node, scope);
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) bind(declaration.id, node.kind === "var" ? scope.variable() : scope,node.kind!=='var');
      if(node.kind==='var'&&scope.variable()===root)declarations.push({node,parent});
    }
    if (node.type === "ImportDeclaration") node.specifiers.forEach(specifier => bind(specifier.local, scope,true));
    children(node, child => build(child, scope,node));
  }
  const root=new Scope(null,"function");root.strict=module||!!evalContext?.strict||strictBody(ast);
  root.container=ast;
  if(evalContext?.declarationScope){root.evalScope=evalContext.declarationScope;root.evalScopeOptional=true;}
  build(ast,root);
  const targets=new WeakSet(),defaultShorthands=new WeakSet(),hoisted=new Set(),movedInitializers=[];
  const globalScript=!module&&!(evalMode&&root.strict)&&(!evalContext||evalContext.global);
  const renameEval=directEval&&!preserveDirectEval;
  const globalLegacyEvalScopes=new Set(globalScript?legacyFunctions.filter(entry=>entry.node.id.name==='eval'&&entry.scope.variable()===root).map(entry=>entry.scope):[]);
  let evalAliasName=evalContext?.evalAliasName||contextName.replace(/\W/g,'_')+'_eval_binding',aliasIndex=0;
  if(!evalContext?.evalAliasName)while(identifiers.has(evalAliasName)||source.includes(evalAliasName))evalAliasName=contextName.replace(/\W/g,'_')+'_eval_binding_'+(++aliasIndex);
  const aliasOwner=node=>{
    if(!renameEval||node.name!=='eval')return null;
    const owner=bindings.has(node)?bindingScopes.get(node):scopes.get(node)?.owner('eval');
    if(owner?.preserveEval||globalLegacyEvalScopes.has(owner))return null;
    if(owner&&owner!==root)return owner;
    if(owner===root&&evalContext&&(!evalContext.global||root.lexical.has('eval')))return owner;
    return !owner&&evalContext?.evalAliasVisible?root:null;
  };
  const aliasWith=(node,token)=>{
    if(!token)return null;
    const owner=aliasOwner(node);if(!owner)return {token,stop:undefined};
    let current=scopes.get(node),inner;
    while(current&&current!==owner){if(current.kind==='with')inner??=current;current=current.parent;}
    const inherited=owner===root&&evalContext?.evalAliasPath&&(!root.names.has('eval')||withAliasVariables.has('eval'));
    if(!inner)return inherited?evalContext.evalAliasPath:null;
    let stop;
    for(current=owner.parent;current;current=current.parent)if(current.kind==='with'){stop=current.token;break;}
    return {token:inner.token,stop:stop||(inherited?evalContext.evalAliasPath.stop:evalContext?.withToken)};
  };
  const aliasDefaults=new WeakSet(),nameContainers=new WeakSet();
  if(renameEval){
    const prepare=node=>{
      if(node.type==='Property'&&node.shorthand&&node.value.type==='AssignmentPattern'&&aliasOwner(node.value.left))aliasDefaults.add(node.value.left);
      if(node.type==='FunctionDeclaration'&&node.id&&aliasOwner(node.id)){
        namedEvalDeclarations.add(node);const owner=bindingScopes.get(node.id);if(owner?.container)nameContainers.add(owner.container);
      }
      children(node,prepare);
    };
    prepare(ast);
  }
  const lexicals=!module&&!evalMode?[...root.lexical].filter(name=>names.has(name)):[];
  if(lexicals.length){
    const offset=ast.body.find(statement=>statement.directive===undefined)?.start??source.length;
    const definitions=lexicals.map(name=>`get [${JSON.stringify(name)}](){return ${name}},set [${JSON.stringify(name)}](value){${name}=value}`).join(',');
    edits.push([offset,offset,`var {}=(${runtimeContext}.__declare_global_lexicals__?.({${definitions}}),0);`]);
  }
  function pattern_ids(pattern,callback){
    if(pattern.type==='Identifier')callback(pattern);
    else if(pattern.type==='AssignmentPattern')pattern_ids(pattern.left,callback);
    else if(pattern.type==='RestElement')pattern_ids(pattern.argument,callback);
    else if(pattern.type==='ArrayPattern')pattern.elements.forEach(item=>{if(item)pattern_ids(item,callback)});
    else if(pattern.type==='ObjectPattern')pattern.properties.forEach(item=>pattern_ids(item.type==='RestElement'?item:item.value,callback));
  }
  if(globalScript)for(const {node} of declarations)for(const declaration of node.declarations)pattern_ids(declaration.id,id=>{if(names.has(id.name))globalVariables.add(id.name)});
  const directVariables=new Set(evalContext&&!root.strict&&!globalScript&&root.evalScope?[...root.names].filter(name=>names.has(name)&&!root.lexical.has(name)):[]);
  const withAliasVariables=new Set(renameEval&&evalContext?.evalAliasVisible&&evalContext.evalAliasPath&&!root.strict&&!globalScript&&root.names.has('eval')&&!root.lexical.has('eval')?['eval']:[]);
  const virtual_variable=id=>(globalVariables.has(id.name)||directVariables.has(id.name)||withAliasVariables.has(id.name))&&scopes.get(id).owner(id.name)===root;
  // Assignment patterns can address the virtual Window directly. Keep bare var
  // declarations for native instantiation, conflicts and property attributes.
  const inferred_name=(node,name)=>{
    if(node.type!=='ArrowFunctionExpression'&&!(node.type==='FunctionExpression'&&!node.id)&&!(node.type==='ClassExpression'&&!node.id))return;
    edits.push([node.start,node.start,'({['+JSON.stringify(name)+']:(']);
    edits.push([node.end,node.end,')})['+JSON.stringify(name)+']']);
  };
  function prepare_pattern(pattern){
    if(pattern.type==='Identifier'){if(virtual_variable(pattern))targets.add(pattern);return;}
    if(pattern.type==='AssignmentPattern'){
      if(pattern.left.type==='Identifier'&&virtual_variable(pattern.left))inferred_name(pattern.right,pattern.left.name);
      prepare_pattern(pattern.left);return;
    }
    if(pattern.type==='ObjectPattern')for(const property of pattern.properties){
      if(property.shorthand&&property.value.type==='AssignmentPattern'&&virtual_variable(property.value.left))defaultShorthands.add(property.value.left);
      prepare_pattern(property.type==='RestElement'?property:property.value);
    }
    else if(pattern.type==='ArrayPattern')pattern.elements.forEach(item=>{if(item)prepare_pattern(item)});
    else if(pattern.type==='RestElement')prepare_pattern(pattern.argument);
  }
  if(globalScript||directVariables.size||withAliasVariables.size)for(const {node,parent} of declarations)for(const declaration of node.declarations){
    let affected=false;pattern_ids(declaration.id,id=>{affected||=virtual_variable(id)});
    if(!affected)continue;
    const loop=['ForInStatement','ForOfStatement'].includes(parent?.type)&&parent.left===node;
    if(!loop&&!declaration.init)continue;
    pattern_ids(declaration.id,id=>hoisted.add(aliasOwner(id)?evalAliasName:id.name));
    prepare_pattern(declaration.id);
    if(loop){
      edits.push([node.start,node.start+3,'']);
      if(declaration.init){
        movedInitializers.push({declaration,parent});
        edits.push([declaration.id.end,node.end,'']);
      }
    }else{
      edits.push([declaration.id.start,declaration.id.start,'{}=(']);
      if(declaration.id.type==='Identifier')inferred_name(declaration.init,declaration.id.name);
      edits.push([declaration.end,declaration.end,',0)']);
    }
  }
  if(hoisted.size){
    const offset=ast.body.find(statement=>statement.directive===undefined)?.start??source.length;
    edits.push([offset,offset,'var '+[...hoisted].join(',')+';']);
  }
  if(globalVariables.size){
    const offset=ast.body.find(statement=>statement.directive===undefined)?.start??source.length;
    edits.push([offset,offset,`var {}=(${runtimeContext}.__declare_global_vars__?.(${JSON.stringify([...globalVariables])}),0);`]);
  }
  if(globalScript&&globalFunctions.size){
    // Global declaration instantiation has already selected and initialized the
    // final function for each name. Mirror its descriptor before authored code,
    // while leaving directive prologues, local eval bindings and modules intact.
    const offset=ast.body.find(statement=>statement.directive===undefined)?.start??source.length;
    const publish=[...globalFunctions].map(name=>`var {}=${runtimeContext}.__publish_global_function__(${JSON.stringify(name)},${name});`).join('');
    edits.push([offset,offset,publish]);
  }
  // Add only the outer var bindings a browser actually instantiates. Keep the
  // authored declarations intact so native execution handles assignment order.
  const legacy_publications=new WeakMap();
  for(const {node,scope,implicit} of legacyFunctions){
    const name=node.id.name,target=scope.variable();
    if(target.parameters?.has(name)||name==='arguments')continue;
    let blocked=false;
    for(let current=scope;current;current=current.parent){
      if(current.lexical.has(name)){blocked=true;break;}
      if(current===target)break;
    }
    if(blocked)continue;
    if(target===root&&globalScript){
      // Existing browser globals retain their virtual value until the authored
      // declaration executes. Publish that function to the virtual Window at
      // the same statement; leaving reads native would expose physical APIs.
      if(implicit)edits.push([node.start,node.start,'{']);
      // An empty binding pattern adds no names and retains the declaration's
      // empty completion, including eval's last preceding expression value.
      const publication=[node.end,node.end,`;var {}=(${globalName===contextName?contextName+'.'+name+'='+name:contextName+'.__publish_legacy_function__('+JSON.stringify(name)+','+name+')'});${implicit?'}':''}`];
      edits.push(publication);legacy_publications.set(node,{publication,name,implicit});
    }else {target.names.add(name);if(target===root&&evalContext&&!root.strict&&root.evalScope)directVariables.add(name);}
  }

  // Sloppy eval can add and delete bindings after this static scope pass.
  // Opaque per-activation tokens select those native cells before globals.
  let eval_index=0;
  const fresh_eval_name=()=>{let name;do{name=contextName.replace(/\W/g,'_')+'_eval_scope_'+(++eval_index)}while(identifiers.has(name)||source.includes(name));identifiers.add(name);return name;};
  const eval_owner=scope=>{while(scope.parent&&scope.kind!=='function'&&!scope.parameterScope)scope=scope.parent;return scope;};
  const direct_calls=new WeakSet(),pending_evals=[];
  const arrow_body_start=node=>{
    let offset=node.params.at(-1)?.end??node.start;
    while(offset<node.body.start){
      if(source.startsWith('/*',offset)){const end=source.indexOf('*/',offset+2);offset=end<0?node.body.start:end+2;}
      else if(source.startsWith('//',offset)){while(offset<node.body.start&&!/[\r\n\u2028\u2029]/.test(source[offset]))offset++;}
      else if(source.startsWith('=>',offset))return offset+2;
      else offset++;
    }
    return node.body.start;
  };
  if(directEval&&!preserveDirectEval){
    const discover=node=>{
      if(node.type==='CallExpression'&&!node.optional&&node.callee.type==='Identifier'&&node.callee.name==='eval'&&(names.has('eval')||aliasOwner(node.callee))&&(!scopes.get(node.callee).has('eval')||virtual_variable(node.callee)||aliasOwner(node.callee))){
        direct_calls.add(node);
        const owner=eval_owner(scopes.get(node));
        // A parameter eval creates its token inside the eval itself. Adding a
        // parameter or a body binding would change native parameter semantics.
        if(!owner.strict&&owner.parameterScope&&!owner.evalScope){owner.evalScope=fresh_eval_name();owner.evalScopeOptional=true;}
        else if(!owner.strict&&!owner.evalScope&&(owner!==root||evalContext&&!evalContext.global)){
          owner.evalScope=fresh_eval_name();
          const body=owner.bodyNode||ast,statement=Array.isArray(body.body)?body.body.find(item=>item.directive===undefined):undefined;
          if(Array.isArray(body.body)){
            const offset=statement?.start??(body===ast?source.length:body.end-1);
            edits.push(owner.evalInitializeEdit=[offset,offset,'const '+owner.evalScope+'='+runtimeContext+'.__eval_scope__();']);
          }else{
            const start=arrow_body_start(owner.functionNode);
            edits.push(owner.evalInitializeEdit=[start,start,'{const '+owner.evalScope+'='+runtimeContext+'.__eval_scope__();return (']);
            edits.push([owner.functionNode.end,owner.functionNode.end,');}']);
          }
        }
      }
      children(node,discover);
    };
    discover(ast);
  }
  if(evalContext&&!root.strict&&!evalContext.global&&root.evalScope){
    const declared=[...root.names].filter(name=>names.has(name)&&!root.lexical.has(name));
    if(declared.length||evalContext.initializeScope){
      const offset=ast.body.find(item=>item.directive===undefined)?.start??source.length;
      const initialize=evalContext.initializeScope?'var '+root.evalScope+';var {}=('+root.evalScope+'||='+runtimeContext+'.__eval_scope__(),0);':'';
      edits.push([offset,offset,initialize+'var {}=('+runtimeContext+'.__eval_declare__('+root.evalScope+','+JSON.stringify(declared)+'),0);']);
    }
  }
  const eval_scopes=scope=>{
    const result=[];
    for(let current=scope;current;current=current.parent)if(current.evalScope){
      const name=current.evalScopeOptional?"(typeof "+current.evalScope+"==='undefined'?undefined:"+current.evalScope+")":current.evalScope;
      if(!result.includes(name))result.push(name);
    }
    for(const name of evalContext?.scopes||[])if(!result.includes(name))result.push(name);
    return result;
  };
  const eval_reference=(node,name,fallback,erase=false,withToken=null)=>{
    const candidates=eval_scopes(scopes.get(node));if(!candidates.length)return fallback;
    const parameter=fresh_eval_name();
    const nativeName=renameEval&&name==='eval'?evalAliasName:name;
    const local='{get ['+JSON.stringify(name)+'](){return '+nativeName+'},set ['+JSON.stringify(name)+']('+parameter+'){'+nativeName+'='+parameter+'}}';
    return (withToken?withToken+'.context':runtimeContext)+'.__eval_reference__(['+candidates.join(',')+'],'+JSON.stringify(name)+','+local+','+fallback+(erase?',()=>delete '+nativeName:'')+')';
  };
  const alias_reference=(node,token,erase=false)=>{
    const path=aliasWith(node,token);
    if(!path){
      const value=evalContext?.evalAliasRef&&!scopes.get(node).owner('eval')?'('+evalContext.evalAliasRef+').eval':evalAliasName;
      return {value,record:'['+value+',undefined]'};
    }
    const reference=path.token+'.evalFallback';
    const stop=path.stop||'undefined';
    return {value:'('+path.token+'.reference("eval",'+scopes.get(node).strict+','+reference+','+stop+')).eval',
      record:path.token+'.evaluation("eval",'+reference+','+stop+')'};
  };
  let with_index=0;
  const with_name=()=>{let name;do{name='__sandstone_with_'+(++with_index)}while(identifiers.has(name)||source.includes(name));return name};
  function visit(node, parent, key, inWith=false,withToken=null) {
    if(untouchedAsm(node))return;
    const initialize=functionScopes.get(node)?.evalInitializeEdit;
    if(initialize&&withToken)initialize[2]=initialize[2].replace(runtimeContext+'.__eval_scope__()',withToken+'.context.__eval_scope__()');
    const legacy=legacy_publications.get(node);
    const runtime=withToken?withToken+'.context':runtimeContext;
    if(nameContainers.has(node)){
      const statement=';var {}=('+runtime+'.__eval_function__('+evalAliasName+'),0);';
      if(node.type==='SwitchStatement'){
        const test=node.cases.find(branch=>branch.test)?.test;
        if(test){edits.push([test.start,test.start,'('+runtime+'.__eval_function__('+evalAliasName+'),']);edits.push([test.end,test.end,')']);}
        else if(node.cases.length){const branch=node.cases[0],offset=branch.consequent[0]?.start??node.end-1;edits.push([offset,offset,statement]);}
      }else if(node.type==='FunctionDeclaration'){
        if(!legacy?.implicit)edits.push([node.start,node.start,'{']);
        edits.push([node.end,node.end,statement+(legacy?.implicit?'':'}'),-1]);
      }else{
        const offset=node.body.find(item=>item.directive===undefined)?.start??(node===ast?source.length:node.end-1);
        edits.push([offset,offset,statement,-1]);
      }
    }
    if(node.type==='FunctionExpression'&&node.id&&aliasOwner(node.id)){
      edits.push([node.start,node.start,'('+runtime+'.__eval_function__((']);edits.push([node.end,node.end,')))']);
    }
    if(legacy&&withToken)legacy.publication[2]=`;var {}=(${globalName===contextName?withToken+'.context.'+legacy.name+'='+legacy.name:withToken+'.context.__publish_legacy_function__('+JSON.stringify(legacy.name)+','+legacy.name+')'});${legacy.implicit?'}':''}`;
    if(node.type==='WithStatement'&&!preserveWith){
      const token=with_name(),runtime=withToken?withToken+'.context':withContext;
      withScopes.get(node).token=token;
      const owner=eval_owner(scopes.get(node)),anchor=renameEval&&(owner!==root||evalContext&&!evalContext.global);
      let aliasFallback='';
      if(renameEval){
        const lookup={name:'eval'};scopes.set(lookup,scopes.get(node.object));
        const inherited=aliasWith(lookup,withToken);
        const parameter=fresh_eval_name();
        const local='{get eval(){return '+evalAliasName+'},set eval('+parameter+'){'+evalAliasName+'='+parameter+'}}';
        aliasFallback=','+(inherited?inherited.token+'.evalFallback':evalContext?.evalAliasRef&&!scopes.get(node.object).owner('eval')?evalContext.evalAliasRef:runtime+'.__eval_binding__('+local+',()=>delete '+evalAliasName+')');
      }
      edits.push([node.object.start,node.object.start,runtime+'.__enter_with__((']);
      const physical=anchor?','+runtime+'.__eval_physical__()?(function(){return this})().eval:undefined':'';
      edits.push([node.object.end,node.object.end,'),'+(withToken||'null')+aliasFallback+(anchor?',('+physical.slice(1)+')':'')+')']);
      const block=node.body.type==='BlockStatement',offset=block?node.body.start+1:node.body.start;
      if(anchor){
        edits.push([node.body.start,node.body.start,'{const '+token+'='+withContext+'.__take_with__();const eval='+token+'.physicalEval;']);
        edits.push([node.body.end,node.body.end,'}',2]);
      }else{
        edits.push([offset,offset,(block?'':'{')+'const '+token+'='+withContext+'.__take_with__();']);
        if(!block)edits.push([node.body.end,node.body.end,'}',2]);
      }
      visit(node.object,node,'object',inWith,withToken);visit(node.body,node,'body',true,token);return;
    }
    if(direct_calls.has(node))pending_evals.push({node,withToken});
    const for_binding=node.type==='VariableDeclaration'&&(parent?.type==='ForStatement'&&key==='init'||['ForInStatement','ForOfStatement'].includes(parent?.type)&&key==='left');
    const default_expression=node.type==='ExportDefaultDeclaration'&&!['FunctionDeclaration','ClassDeclaration'].includes(node.declaration.type);
    // Mapping this introduces a leading parenthesis. Preserve the parser's
    // original ASI boundaries so it cannot turn the next statement into a call
    // on a preceding initializer, return value or field expression.
    if(!for_binding&&(terminated_nodes.has(node.type)||default_expression)&&source[node.end-1]!==';')edits.push([node.end,node.end,';',1]);
    if (resolve && ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
      const type=static_module_type(node),namespace=node.specifiers?.find(specifier=>specifier.type==='ImportNamespaceSpecifier');
      const bridge=(namespace||node.type==='ExportAllDeclaration'&&node.exported)&&resolveNamespace?.(node.source.value,type);
      if(bridge){
        let replacement;
        if(namespace){
          const normal=node.specifiers.find(specifier=>specifier.type==='ImportDefaultSpecifier');
          replacement=(normal?'import '+normal.local.name+' from '+JSON.stringify(resolve(node.source.value,type))+';':'')+'import {namespace as '+namespace.local.name+'} from '+JSON.stringify(bridge)+';';
        }else replacement='export {namespace as '+(node.exported.name||JSON.stringify(node.exported.value))+'} from '+JSON.stringify(bridge)+';';
        edits.push([node.start,node.end,replacement]);return;
      }
      edits.push([node.source.start, node.source.end, JSON.stringify(resolve(node.source.value,type))]);
      if (stripAttributes && node.attributes?.length) edits.push([node.source.end, node.end, ";"]);
    }
    if ((url||dynamicImport) && node.type === "ImportExpression") {
      edits.push([node.start, node.start + 6, `${withToken?withToken+'.context':contextName}.__import__.bind(null,${dynamicImport?'null':JSON.stringify(importReferrer)})`]);
    }
    if (url && node.type === "MetaProperty" && node.meta.name === "import") {
      edits.push([node.start, node.end, `${contextName}.__module_meta__(${JSON.stringify(url)})`]);
      return;
    }
    const aliasInferred=(node.type==='AssignmentExpression'&&['=','||=','&&=','??='].includes(node.operator)||node.type==='AssignmentPattern')&&node.left.type==='Identifier'&&aliasOwner(node.left)&&!virtual_variable(node.left);
    if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&aliasOwner(node.id)&&!virtual_variable(node.id)&&node.init)inferred_name(node.init,'eval');
    const inferred=aliasInferred||(node.type==='AssignmentExpression'&&['=','||=','&&=','??='].includes(node.operator)||node.type==='AssignmentPattern')&&node.left.type==='Identifier'&&names.has(node.left.name)&&!bindings.has(node.left)&&(!scopes.get(node.left).has(node.left.name)||virtual_variable(node.left));
    if(inferred){
      inferred_name(node.right,node.left.name);
      if(node.type==='AssignmentPattern'&&parent?.type==='Property'&&parent.shorthand)defaultShorthands.add(node.left);
    }
    if(node.type==='Identifier'&&aliasOwner(node)&&(!virtual_variable(node)||withAliasVariables.has(node.name)&&scopes.get(node).owner(node.name)===root||bindings.has(node)&&!targets.has(node))){
      let reference=true;
      if((parent?.type==='MemberExpression'||parent?.type==='OptionalMemberExpression')&&key==='property'&&!parent.computed)reference=false;
      if(['Property','MethodDefinition','PropertyDefinition','FieldDefinition'].includes(parent?.type)&&key==='key'&&!parent.computed)reference=false;
      if(['LabeledStatement','BreakStatement','ContinueStatement','MetaProperty','ImportSpecifier','ExportSpecifier'].includes(parent?.type))reference=false;
      if(reference){
        const shorthand=parent?.type==='Property'&&parent.shorthand&&key==='value'||aliasDefaults.has(node);
        const value=bindings.has(node)&&!targets.has(node)?evalAliasName:alias_reference(node,withToken,parent?.type==='UnaryExpression'&&parent.operator==='delete').value;
        edits.push([node.start,node.end,(shorthand?'eval: ':'')+value]);
      }
    }else if (node.type === "ThisExpression"&&rewriteThis) {
      edits.push([node.start, node.end, `(${withToken?withToken+'.context.__get_this__':thisName}(this,${scopes.get(node).strict}))`]);
    } else if (node.type === "Identifier" && names.has(node.name) && (targets.has(node)||!bindings.has(node)&&(!scopes.get(node).has(node.name)||virtual_variable(node)))) {
      let reference = true;
      if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && key === "property" && !parent.computed) reference = false;
      if (["Property", "MethodDefinition", "PropertyDefinition", "FieldDefinition"].includes(parent?.type) && key === "key" && !parent.computed) reference = false;
      if (["LabeledStatement", "BreakStatement", "ContinueStatement", "MetaProperty", "ImportSpecifier", "ExportSpecifier"].includes(parent?.type)) reference = false;
      if(preserveWith&&inWith)reference=false;
      if(preserveGlobalScope&&node.name!=='eval')reference=false;
      if(preserveDirectEval&&node.name==='eval'&&parent?.type==='CallExpression'&&key==='callee'&&!parent.optional)reference=false;
      if (reference) {
        const shorthand = parent?.type === "Property" && parent.shorthand && key === "value";
        const fallback=eval_reference(node,node.name,withToken?withToken+'.context.__globals__':globalName,parent?.type==='UnaryExpression'&&parent.operator==='delete',withToken);
        const base=withToken?`${withToken}.reference(${JSON.stringify(node.name)},${scopes.get(node).strict},${fallback})`:fallback;
        const value=(withToken||eval_scopes(scopes.get(node)).length?'('+base+')':base)+'.'+node.name;
        // An identifier call has no property receiver. Native global methods
        // already bind their required Window; authored strict functions must
        // receive undefined here, including optional calls and template tags.
        const unbound=parent?.type==='CallExpression'&&key==='callee'||parent?.type==='TaggedTemplateExpression'&&key==='tag';
        const expression=unbound?(withToken?`${withToken}.callee(${JSON.stringify(node.name)},${scopes.get(node).strict},${fallback})`:'(0,'+value+')'):value;
        edits.push([node.start, node.end, `${shorthand||defaultShorthands.has(node) ? node.name + ": " : ""}${expression}`]);
      }
    }
    children(node, (child, childKey) => visit(child, node, childKey,inWith||node.type==='WithStatement'&&childKey==='body',withToken));
  }
  visit(ast,undefined,undefined,!!evalContext?.withToken,evalContext?.withToken||null);
  const render=(start,end)=>{
    let result='',offset=start;
    for(const [from,to,text] of edits.filter(([from,to])=>from>=start&&to<=end).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||(a[3]||0)-(b[3]||0))){
      if(from<offset)continue;result+=source.slice(offset,from)+text;offset=to;
    }
    return result+source.slice(offset,end);
  };
  // Finish inner calls first so argument rewrites survive the outer edit.
  // Only the selected branch evaluates arguments; a replaced eval keeps its
  // ordinary call path, while intrinsic eval retains the caller's environment.
  for(const {node,withToken} of pending_evals.sort((a,b)=>b.node.start-a.node.start)){
    const scope=scopes.get(node),owner=eval_owner(scope),locals=new Set(evalContext?.locals);
    for(let current=scope;current;current=current.parent){
      for(const name of current===root&&globalScript?current.lexical:current.names)if(current!==root||!directVariables.has(name))locals.add(name);
    }
    const metadata={strict:scope.strict,global:owner===root&&(!evalContext||!!evalContext.global),spread:node.arguments.some(argument=>argument.type==='SpreadElement'),
      locals:[...locals],scopes:eval_scopes(scope),declarationScope:owner.evalScope,initializeScope:!!owner.parameterScope,
      privateNames:[...privateNames],url,importReferrer:dynamicImport?null:importReferrer,withToken:withToken||undefined,
      evalAliasName:renameEval?evalAliasName:undefined,evalAliasVisible:!!aliasOwner(node.callee)&&(!virtual_variable(node.callee)||withAliasVariables.has(node.callee.name))};
    const aliasPath=aliasOwner(node.callee)?aliasWith(node.callee,withToken):null;
    if(aliasPath){metadata.evalAliasRef=aliasPath.token+'.evalFallback';metadata.evalAliasPath=aliasPath;}
    else if(evalContext?.evalAliasRef&&!scope.owner('eval'))metadata.evalAliasRef=evalContext.evalAliasRef;
    const args=node.arguments.length?render(node.arguments[0].start,node.arguments.at(-1).end):'';
    const runtime=withToken?withToken+'.context':runtimeContext;
    const reference=eval_reference(node.callee,'eval',withToken?runtime+'.__globals__':globalName,false,withToken);
    const callee=aliasOwner(node.callee)&&(!virtual_variable(node.callee)||withAliasVariables.has(node.callee.name))?alias_reference(node.callee,withToken).record:withToken?withToken+'.evaluation("eval",'+reference+')':'['+reference+'.eval,undefined]';
    const replacement='('+runtime+'.__eval_select__('+callee+',()=>eval)?eval('+(metadata.spread?'...':'')+runtime+'.__eval_prepare__(['+args+'],'+JSON.stringify(metadata)+')):'+runtime+'.__eval_custom__()('+args+'))';
    for(let index=edits.length-1;index>=0;index--)if(edits[index][0]>=node.start&&edits[index][1]<=node.end&&edits[index][0]<node.end&&!(edits[index][0]===node.start&&edits[index][1]===node.start))edits.splice(index,1);
    edits.push([node.start,node.end,replacement]);
  }
  for(const {declaration,parent} of movedInitializers){
    const init=declaration.init,parts=[];let offset=init.start;
    for(const [start,end,text] of edits.filter(([start,end])=>start>=init.start&&end<=init.end).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||(a[3]||0)-(b[3]||0))){
      if(start<offset)continue;parts.push(source.slice(offset,start),text);offset=end;
    }
    parts.push(source.slice(offset,init.end));
    const name=declaration.id.name,target=edits.find(([start,end])=>start===declaration.id.start&&end===declaration.id.end&&end>start)?.[2]||name;
    edits.push([parent.right.start,parent.right.start,'('+target+'=({['+JSON.stringify(name)+']:('+parts.join('')+')})['+JSON.stringify(name)+'],']);
    edits.push([parent.right.end,parent.right.end,')']);
  }
  edits.sort((a, b) => a[0] - b[0]||a[1]-b[1]||(a[3]||0)-(b[3]||0));
  let output = "";
  let offset = 0;
  for (const [start, end, replacement] of edits) {
    if (start < offset) continue;
    output += source.slice(offset, start) + replacement;
    offset = end;
  }
  output+=source.slice(offset);
  // Bundlers may derive their next asset URL from Error.stack. Give relocated
  // scripts their virtual filename while retaining an author's explicit label.
  if(sourceURL&&!named)output+='\n//# sourceURL='+String(sourceURL).replace(/[\r\n\u2028\u2029]/g,'')+'\n';
  return output;
}

// Dynamic constructors supply a native-validated function source. Rewrite the
// complete parameter/body scope, using private bindings absent from that source.
export function rewrite_dynamic_function(source,globals,options={}){
  let expression='('+source+')';
  const ast=parse(expression,{ranges:true,webcompat:true,next:true}),names=new Set();
  let needsScope=false,hasDirectEval=false;
  function collect(node){
    if(node.type==='Identifier')names.add(node.name);
    if(node.type==='WithStatement')needsScope=true;
    if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='eval'&&!node.optional){needsScope=true;hasDirectEval=true;}
    children(node,collect);
  }
  collect(ast);
  const unique=base=>{let name=base,index=0;while(names.has(name)||source.includes(name))name=base+(++index);names.add(name);return name;};
  const contextName=unique('__sandstone_dynamic_context__'),thisName=unique('__sandstone_dynamic_this__'),scopeName=unique('__sandstone_dynamic_scope__');
  // "anonymous" is the native display name, without a lexical name binding.
  // Keep the expression anonymous and restore its native name after compiling.
  const id=ast.body[0].expression.id;
  if(id)expression=expression.slice(0,id.start)+expression.slice(id.end);
  // Sloppy direct eval can introduce bindings that no static scope pass sees.
  // Let the native environment resolve those names before its global fallback.
  return {source:rewrite_source(expression,globals,{...options,contextName,globalName:options.lexicalGlobals?contextName+'.__globals__':contextName,thisName,dynamicImport:true,withContext:options.withContext||contextName,preserveWith:!options.directEval,preserveDirectEval:!options.directEval,preserveGlobalScope:hasDirectEval}),contextName,thisName,scopeName,needsScope};
}
