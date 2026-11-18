import { parse } from "../javascript_parser.mjs";
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

export function rewrite_source(source, globals, {module = false, url, resolve, stripAttributes = false, sourceURL, contextName='__ctx__',globalName=contextName,thisName='__get_this__',dynamicImport=false,preserveWith=false,preserveDirectEval=false,preserveGlobalScope=false,evalMode=false} = {}) {
  let named=false;
  const onComment=sourceURL?(type,text)=>{
    if(type==='SingleLine'&&/^[#@]\s+sourceURL=\s*\S+\s*$/.test(text))named=true;
  }:undefined;
  const ast = parse(source, {ranges: true, webcompat: true, module, next: true, onComment});
  const scopes = new WeakMap();
  const bindings = new WeakSet();
  const names = new Set(globals);
  const edits = [];
  const functionBodies=new WeakSet(),legacyFunctions=[],globalFunctions=new Set(),globalVariables=new Set(),declarations=[],identifiers=new Set();
  const strictBody=node=>Array.isArray(node?.body)&&node.body.some(statement=>statement.directive==='use strict');

  function bind(pattern, scope, lexical=false) {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      scope.names.add(pattern.name);
      if(lexical)scope.lexical.add(pattern.name);
      bindings.add(pattern);
    } else if (pattern.type === "AssignmentPattern") bind(pattern.left, scope,lexical);
    else if (pattern.type === "RestElement") bind(pattern.argument, scope,lexical);
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(element => bind(element, scope,lexical));
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach(property => bind(property.type === "RestElement" ? property.argument : property.value, scope,lexical));
  }

  function build(node, scope,parent) {
    if(node.type==='Identifier')identifiers.add(node.name);
    if (node.type === "FunctionDeclaration") {
      // Annex B treats unbraced if arms as implicit lexical blocks.
      if(parent?.type==='IfStatement')scope=new Scope(scope,"block");
      const block=scope.kind!=="function"&&!scope.body;
      bind(node.id,block?scope:scope.variable(),block&&(node.async||node.generator));
      if(!module&&!block&&node.id&&scope.variable()===root&&names.has(node.id.name))globalFunctions.add(node.id.name);
      if(block&&!scope.strict&&!node.async&&!node.generator&&names.has(node.id.name))legacyFunctions.push({node,scope,implicit:parent?.type==='IfStatement'});
    }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      // Parameter initializers run outside the body's variable environment.
      // Closures created there must not capture a later body var/function.
      scope = new Scope(scope, "block");
      scope.strict ||= strictBody(node.body);
      if (node.type === "FunctionExpression") bind(node.id, scope);
      node.params.forEach(param => bind(param, scope));
      scopes.set(node,scope);
      const bodyScope=new Scope(scope,"function");
      bodyScope.parameters=scope.names;
      if(node.body.type==='BlockStatement')functionBodies.add(node.body);
      children(node,(child,key)=>build(child,key==='body'?bodyScope:scope,node));
      return;
    } else if(node.type==='StaticBlock'){
      // A class static block owns both its lexical and var declarations.
      // Neither may suppress global rewriting in other fields or outer code.
      scope=new Scope(scope,"function");
    } else if(node.type==='SwitchStatement'){
      scopes.set(node,scope);
      build(node.discriminant,scope,node);
      // The discriminant precedes the shared lexical environment of all cases.
      const caseScope=new Scope(scope,"block");
      node.cases.forEach(branch=>build(branch,caseScope,node));
      return;
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.type === "ClassDeclaration") bind(node.id, scope,true);
      scope = new Scope(scope, "block");
      scope.strict=true;
      bind(node.id, scope,true);
    } else if (["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement"].includes(node.type)) {
      scope = new Scope(scope, "block");
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
  const root=new Scope(null,"function");root.strict=module||strictBody(ast);
  build(ast,root);
  const targets=new WeakSet(),defaultShorthands=new WeakSet(),hoisted=new Set(),movedInitializers=[];
  const globalScript=!module&&!(evalMode&&root.strict);
  const lexicals=!module&&!evalMode?[...root.lexical].filter(name=>names.has(name)):[];
  if(lexicals.length){
    const offset=ast.body.find(statement=>statement.directive===undefined)?.start??source.length;
    const definitions=lexicals.map(name=>`get [${JSON.stringify(name)}](){return ${name}},set [${JSON.stringify(name)}](value){${name}=value}`).join(',');
    edits.push([offset,offset,`var {}=(${contextName}.__declare_global_lexicals__?.({${definitions}}),0);`]);
  }
  function pattern_ids(pattern,callback){
    if(pattern.type==='Identifier')callback(pattern);
    else if(pattern.type==='AssignmentPattern')pattern_ids(pattern.left,callback);
    else if(pattern.type==='RestElement')pattern_ids(pattern.argument,callback);
    else if(pattern.type==='ArrayPattern')pattern.elements.forEach(item=>{if(item)pattern_ids(item,callback)});
    else if(pattern.type==='ObjectPattern')pattern.properties.forEach(item=>pattern_ids(item.type==='RestElement'?item:item.value,callback));
  }
  if(globalScript)for(const {node} of declarations)for(const declaration of node.declarations)pattern_ids(declaration.id,id=>{if(names.has(id.name))globalVariables.add(id.name)});
  const virtual_variable=id=>globalVariables.has(id.name)&&scopes.get(id).owner(id.name)===root;
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
  if(globalScript)for(const {node,parent} of declarations)for(const declaration of node.declarations){
    let affected=false;pattern_ids(declaration.id,id=>{affected||=virtual_variable(id)});
    if(!affected)continue;
    const loop=['ForInStatement','ForOfStatement'].includes(parent?.type)&&parent.left===node;
    if(!loop&&!declaration.init)continue;
    pattern_ids(declaration.id,id=>hoisted.add(id.name));
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
    edits.push([offset,offset,`var {}=(${contextName}.__declare_global_vars__?.(${JSON.stringify([...globalVariables])}),0);`]);
  }
  if(!module&&!(evalMode&&root.strict)&&globalFunctions.size){
    // Global declaration instantiation has already selected and initialized the
    // final function for each name. Mirror its descriptor before authored code,
    // while leaving directive prologues, local eval bindings and modules intact.
    const offset=ast.body.find(statement=>statement.directive===undefined)?.start??source.length;
    const publish=[...globalFunctions].map(name=>`var {}=${contextName}.__publish_global_function__(${JSON.stringify(name)},${name});`).join('');
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
    if(target===root){
      // Existing browser globals retain their virtual value until the authored
      // declaration executes. Publish that function to the virtual Window at
      // the same statement; leaving reads native would expose physical APIs.
      if(implicit)edits.push([node.start,node.start,'{']);
      // An empty binding pattern adds no names and retains the declaration's
      // empty completion, including eval's last preceding expression value.
      const publication=[node.end,node.end,`;var {}=(${globalName===contextName?contextName+'.'+name+'='+name:contextName+'.__publish_legacy_function__('+JSON.stringify(name)+','+name+')'});${implicit?'}':''}`];
      edits.push(publication);legacy_publications.set(node,{publication,name,implicit});
    }else target.names.add(name);
  }

  let with_index=0;
  const with_name=()=>{let name;do{name='__sandstone_with_'+(++with_index)}while(identifiers.has(name)||source.includes(name));return name};
  function visit(node, parent, key, inWith=false,withToken=null) {
    if (node.type === "BlockStatement" && node.body[0]?.directive === "use asm") return;
    const legacy=legacy_publications.get(node);
    if(legacy&&withToken)legacy.publication[2]=`;var {}=(${globalName===contextName?withToken+'.context.'+legacy.name+'='+legacy.name:withToken+'.context.__publish_legacy_function__('+JSON.stringify(legacy.name)+','+legacy.name+')'});${legacy.implicit?'}':''}`;
    if(node.type==='WithStatement'&&!preserveWith){
      const token=with_name(),runtime='(function(){return this})().__ctx__';
      edits.push([node.object.start,node.object.start,runtime+'.__enter_with__((']);
      edits.push([node.object.end,node.object.end,'),'+(withToken||'null')+')']);
      const block=node.body.type==='BlockStatement',offset=block?node.body.start+1:node.body.start;
      edits.push([offset,offset,(block?'':'{')+'const '+token+'='+runtime+'.__take_with__();']);
      if(!block)edits.push([node.body.end,node.body.end,'}',2]);
      visit(node.object,node,'object',inWith,withToken);visit(node.body,node,'body',true,token);return;
    }
    const for_binding=node.type==='VariableDeclaration'&&(parent?.type==='ForStatement'&&key==='init'||['ForInStatement','ForOfStatement'].includes(parent?.type)&&key==='left');
    const default_expression=node.type==='ExportDefaultDeclaration'&&!['FunctionDeclaration','ClassDeclaration'].includes(node.declaration.type);
    // Mapping this introduces a leading parenthesis. Preserve the parser's
    // original ASI boundaries so it cannot turn the next statement into a call
    // on a preceding initializer, return value or field expression.
    if(!for_binding&&(terminated_nodes.has(node.type)||default_expression)&&source[node.end-1]!==';')edits.push([node.end,node.end,';',1]);
    if (resolve && ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
      edits.push([node.source.start, node.source.end, JSON.stringify(resolve(node.source.value))]);
      if (stripAttributes && node.attributes?.length) edits.push([node.source.end, node.end, ";"]);
    }
    if ((url||dynamicImport) && node.type === "ImportExpression") {
      edits.push([node.start, node.start + 6, `${withToken?withToken+'.context':contextName}.__import__.bind(null,${dynamicImport?'null':JSON.stringify(url)})`]);
    }
    if (url && node.type === "MetaProperty" && node.meta.name === "import") {
      edits.push([node.start, node.end, `${contextName}.__module_meta__(${JSON.stringify(url)})`]);
      return;
    }
    const inferred=(node.type==='AssignmentExpression'&&['=','||=','&&=','??='].includes(node.operator)||node.type==='AssignmentPattern')&&node.left.type==='Identifier'&&names.has(node.left.name)&&!bindings.has(node.left)&&(!scopes.get(node.left).has(node.left.name)||virtual_variable(node.left));
    if(inferred){
      inferred_name(node.right,node.left.name);
      if(node.type==='AssignmentPattern'&&parent?.type==='Property'&&parent.shorthand)defaultShorthands.add(node.left);
    }
    if (node.type === "ThisExpression") {
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
        const value=withToken?`${withToken}.reference(${JSON.stringify(node.name)},${scopes.get(node).strict}).${node.name}`:`${globalName}.${node.name}`;
        // An identifier call has no property receiver. Native global methods
        // already bind their required Window; authored strict functions must
        // receive undefined here, including optional calls and template tags.
        const unbound=parent?.type==='CallExpression'&&key==='callee'||parent?.type==='TaggedTemplateExpression'&&key==='tag';
        const expression=unbound?(withToken?`${withToken}.callee(${JSON.stringify(node.name)},${scopes.get(node).strict})`:'(0,'+value+')'):value;
        edits.push([node.start, node.end, `${shorthand||defaultShorthands.has(node) ? node.name + ": " : ""}${expression}`]);
      }
    }
    children(node, (child, childKey) => visit(child, node, childKey,inWith||node.type==='WithStatement'&&childKey==='body',withToken));
  }
  visit(ast);
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
  return {source:rewrite_source(expression,globals,{...options,contextName,globalName:options.lexicalGlobals?contextName+'.__globals__':contextName,thisName,dynamicImport:true,preserveWith:true,preserveDirectEval:true,preserveGlobalScope:hasDirectEval}),contextName,thisName,scopeName,needsScope};
}
