import { parse } from "meriyah";
const terminated_nodes=new Set(['ExpressionStatement','VariableDeclaration','ReturnStatement','ThrowStatement','BreakStatement','ContinueStatement','DebuggerStatement','DoWhileStatement','PropertyDefinition','FieldDefinition']);

class Scope {
  constructor(parent, kind) { this.parent = parent; this.kind = kind; this.names = new Set(); }
  has(name) { return this.names.has(name) || !!this.parent?.has(name); }
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

export function rewrite_source(source, globals, {module = false, url, resolve, stripAttributes = false, sourceURL, contextName='__ctx__',thisName='__get_this__',dynamicImport=false,preserveWith=false,preserveDirectEval=false,preserveGlobalScope=false} = {}) {
  let named=false;
  const onComment=sourceURL?(type,text)=>{
    if(type==='SingleLine'&&/^[#@]\s+sourceURL=\s*\S+\s*$/.test(text))named=true;
  }:undefined;
  const ast = parse(source, {ranges: true, webcompat: true, module, next: true, onComment});
  const scopes = new WeakMap();
  const bindings = new WeakSet();
  const names = new Set(globals);
  const edits = [];

  function bind(pattern, scope) {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      scope.names.add(pattern.name);
      bindings.add(pattern);
    } else if (pattern.type === "AssignmentPattern") bind(pattern.left, scope);
    else if (pattern.type === "RestElement") bind(pattern.argument, scope);
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(element => bind(element, scope));
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach(property => bind(property.type === "RestElement" ? property.argument : property.value, scope));
  }

  function build(node, scope) {
    if (node.type === "FunctionDeclaration") bind(node.id, scope);
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      // Parameter initializers run outside the body's variable environment.
      // Closures created there must not capture a later body var/function.
      scope = new Scope(scope, "block");
      if (node.type === "FunctionExpression") bind(node.id, scope);
      node.params.forEach(param => bind(param, scope));
      scopes.set(node,scope);
      const bodyScope=new Scope(scope,"function");
      children(node,(child,key)=>build(child,key==='body'?bodyScope:scope));
      return;
    } else if(node.type==='StaticBlock'){
      // A class static block owns both its lexical and var declarations.
      // Neither may suppress global rewriting in other fields or outer code.
      scope=new Scope(scope,"function");
    } else if(node.type==='SwitchStatement'){
      scopes.set(node,scope);
      build(node.discriminant,scope);
      // The discriminant precedes the shared lexical environment of all cases.
      const caseScope=new Scope(scope,"block");
      node.cases.forEach(branch=>build(branch,caseScope));
      return;
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.type === "ClassDeclaration") bind(node.id, scope);
      scope = new Scope(scope, "block");
      bind(node.id, scope);
    } else if (["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement"].includes(node.type)) {
      scope = new Scope(scope, "block");
      if (node.type === "CatchClause") bind(node.param, scope);
    }
    scopes.set(node, scope);
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) bind(declaration.id, node.kind === "var" ? scope.variable() : scope);
    }
    if (node.type === "ImportDeclaration") node.specifiers.forEach(specifier => bind(specifier.local, scope));
    children(node, child => build(child, scope));
  }
  build(ast, new Scope(null, "function"));

  function visit(node, parent, key, inWith=false) {
    if (node.type === "BlockStatement" && node.body[0]?.directive === "use asm") return;
    const for_binding=node.type==='VariableDeclaration'&&(parent?.type==='ForStatement'&&key==='init'||['ForInStatement','ForOfStatement'].includes(parent?.type)&&key==='left');
    const default_expression=node.type==='ExportDefaultDeclaration'&&!['FunctionDeclaration','ClassDeclaration'].includes(node.declaration.type);
    // Mapping this introduces a leading parenthesis. Preserve the parser's
    // original ASI boundaries so it cannot turn the next statement into a call
    // on a preceding initializer, return value or field expression.
    if(!for_binding&&(terminated_nodes.has(node.type)||default_expression)&&source[node.end-1]!==';')edits.push([node.end,node.end,';']);
    if (resolve && ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
      edits.push([node.source.start, node.source.end, JSON.stringify(resolve(node.source.value))]);
      if (stripAttributes && node.attributes?.length) edits.push([node.source.end, node.end, ";"]);
    }
    if ((url||dynamicImport) && node.type === "ImportExpression") {
      edits.push([node.start, node.start + 6, `${contextName}.__import__.bind(null,${dynamicImport?'null':JSON.stringify(url)})`]);
    }
    if (url && node.type === "MetaProperty" && node.meta.name === "import") {
      edits.push([node.start, node.end, `${contextName}.__module_meta__(${JSON.stringify(url)})`]);
      return;
    }
    if (node.type === "ThisExpression") {
      edits.push([node.start, node.end, `(${thisName}(this))`]);
    } else if (node.type === "Identifier" && names.has(node.name) && !bindings.has(node) && !scopes.get(node).has(node.name)) {
      let reference = true;
      if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && key === "property" && !parent.computed) reference = false;
      if (["Property", "MethodDefinition", "PropertyDefinition", "FieldDefinition"].includes(parent?.type) && key === "key" && !parent.computed) reference = false;
      if (["LabeledStatement", "BreakStatement", "ContinueStatement", "MetaProperty", "ImportSpecifier", "ExportSpecifier"].includes(parent?.type)) reference = false;
      if(preserveWith&&inWith)reference=false;
      if(preserveGlobalScope&&node.name!=='eval')reference=false;
      if(preserveDirectEval&&node.name==='eval'&&parent?.type==='CallExpression'&&key==='callee'&&!parent.optional)reference=false;
      if (reference) {
        const shorthand = parent?.type === "Property" && parent.shorthand && key === "value";
        edits.push([node.start, node.end, `${shorthand ? node.name + ": " : ""}${contextName}.${node.name}`]);
      }
    }
    children(node, (child, childKey) => visit(child, node, childKey,inWith||node.type==='WithStatement'&&childKey==='body'));
  }
  visit(ast);
  edits.sort((a, b) => a[0] - b[0]);
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
  return {source:rewrite_source(expression,globals,{...options,contextName,thisName,dynamicImport:true,preserveWith:true,preserveDirectEval:true,preserveGlobalScope:hasDirectEval}),contextName,thisName,scopeName,needsScope};
}
