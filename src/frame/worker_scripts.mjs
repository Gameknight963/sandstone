import { parse } from "meriyah";

// Discover literal and constant importScripts URLs without running page code.
// Unresolved calls are handled by an isolated, network-disabled discovery worker.
export function worker_imports(source, base) {
  let ast;
  try { ast = parse(source, {webcompat: true, next: true}); }
  catch { return {urls: [], dynamic: false}; }
  const urls = new Set();
  let dynamic = false;
  const constants = new Map();
  function value(node, scope) {
    if (!node) return undefined;
    if (node.type === "Literal") return node.value;
    if (node.type === "Identifier") return scope.get(node.name);
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = value(node.left, scope), right = value(node.right, scope);
      if (left !== undefined && right !== undefined) return left + right;
    }
    if (node.type === "TemplateLiteral") {
      let result = node.quasis[0].value.cooked;
      for (let i = 0; i < node.expressions.length; i++) {
        const part = value(node.expressions[i], scope);
        if (part === undefined) return undefined;
        result += part + node.quasis[i + 1].value.cooked;
      }
      return result;
    }
    return undefined;
  }
  for (const statement of ast.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type === "Identifier") constants.set(declaration.id.name, value(declaration.init, constants));
    }
  }
  function walk(node, scope) {
    if (!node?.type) return;
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      scope = new Map(scope);
      for (const parameter of node.params) if (parameter.type === "Identifier") scope.delete(parameter.name);
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const imports = callee.type === "Identifier" && callee.name === "importScripts" || callee.type === "MemberExpression" &&
        (callee.computed ? callee.property.value === "importScripts" : callee.property.name === "importScripts");
      if (imports) for (const argument of node.arguments) {
        const path = value(argument, scope);
        if (typeof path !== "string") { dynamic = true; continue; }
        try { urls.add(new URL(path, base).href); } catch { dynamic = true; }
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(item => walk(item, scope));
      else if (child?.type) walk(child, scope);
    }
  }
  walk(ast, constants);
  return {urls: [...urls], dynamic};
}

export async function prefetch_worker_scripts(source, base, fetch, cache = new Map()) {
  const queue = [source];
  let dynamic = false;
  while (queue.length) {
    const next = worker_imports(queue.shift(), base);
    dynamic ||= next.dynamic;
    for (const url of next.urls) {
      if (cache.has(url)) continue;
      cache.set(url, false);
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const text = await response.text();
        cache.set(url, text);
        queue.push(text);
      } catch {}
    }
  }
  return {cache, dynamic};
}
