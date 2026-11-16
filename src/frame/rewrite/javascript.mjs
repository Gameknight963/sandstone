import { parse } from "meriyah";

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

export function rewrite_source(source, globals, {module = false} = {}) {
  const ast = parse(source, {ranges: true, webcompat: true, module, next: true});
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
      scope = new Scope(scope, "function");
      if (node.type === "FunctionExpression") bind(node.id, scope);
      node.params.forEach(param => bind(param, scope));
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.type === "ClassDeclaration") bind(node.id, scope);
      scope = new Scope(scope, "block");
      bind(node.id, scope);
    } else if (["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement"].includes(node.type)) {
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

  function visit(node, parent, key) {
    if (node.type === "BlockStatement" && node.body[0]?.directive === "use asm") return;
    if (node.type === "ThisExpression") {
      edits.push([node.start, node.end, "(__get_this__(this))"]);
    } else if (node.type === "Identifier" && names.has(node.name) && !bindings.has(node) && !scopes.get(node).has(node.name)) {
      let reference = true;
      if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && key === "property" && !parent.computed) reference = false;
      if (["Property", "MethodDefinition", "PropertyDefinition", "FieldDefinition"].includes(parent?.type) && key === "key" && !parent.computed) reference = false;
      if (["LabeledStatement", "BreakStatement", "ContinueStatement", "MetaProperty", "ImportSpecifier", "ExportSpecifier"].includes(parent?.type)) reference = false;
      if (reference) {
        const shorthand = parent?.type === "Property" && parent.shorthand && key === "value";
        edits.push([node.start, node.end, `${shorthand ? node.name + ": " : ""}__ctx__.${node.name}`]);
      }
    }
    children(node, (child, childKey) => visit(child, node, childKey));
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
  return output + source.slice(offset);
}
