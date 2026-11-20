import { parse } from "./javascript_parser.mjs";
import {asynchronous_worker_imports} from './rewrite/worker_loaders.mjs';

// Discover literal imports and declared lazy bundle assets without running code.
// Unresolved calls are handled by an isolated, network-disabled discovery worker.
export function worker_imports(source, base, {scriptURL=base,asyncLoaders=false,staticAMD=false,amdURL=scriptURL}={}) {
  let ast;
  try { ast = parse(source, {ranges:true,webcompat: true, next: true}); }
  catch { return {urls: [], dynamic: false}; }
  const urls = new Set();
  const transports=asyncLoaders||staticAMD?asynchronous_worker_imports(ast):new Set();
  let amdComplete=true,amdDeclared=false;
  function amd(node){
    if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='define'){
      const dependencies=node.arguments[0],factory=node.arguments[1];
      if(dependencies?.type!=='ArrayExpression'){amdComplete=false;return;}
      amdDeclared=true;
      for(let index=0;index<dependencies.elements.length;index++){
        const value=dependencies.elements[index];if(value?.type!=='Literal'||typeof value.value!=='string'){amdComplete=false;continue;}
        const name=value.value;
        if(name==='require'){
          const parameter=factory?.params?.[index];
          if(parameter?.type==='Identifier'){
            const scan=value=>{if(value.type==='CallExpression'&&value.callee.type==='Identifier'&&value.callee.name===parameter.name)amdComplete=false;for(const child of Object.values(value))if(Array.isArray(child)){for(const entry of child)if(entry?.type)scan(entry);}else if(child?.type)scan(child);};
            scan(factory.body);
          }
          continue;
        }
        if(name==='exports'||name==='module')continue;
        if(name.includes('!')){amdComplete=false;continue;}
        try{const path=/\.m?js(?:[?#]|$)/i.test(name)?name:name.replace(/([?#]|$)/,'.js$1'),url=new URL(path,amdURL);if(!/^https?:$/.test(url.protocol))amdComplete=false;else urls.add(url.href);}catch{amdComplete=false;}
      }
    }
    for(const child of Object.values(node))if(Array.isArray(child)){for(const entry of child)if(entry?.type)amd(entry);}else if(child?.type)amd(child);
  }
  if(staticAMD)amd(ast);
  const asynchronous=asyncLoaders||staticAMD&&amdDeclared&&amdComplete?transports:new Set();
  let dynamic = false;
  const constants = new Map();
  const member=node=>node?.type==='MemberExpression'?(node.computed?node.property.value:node.property.name):undefined;
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
      // Parcel registers lazy bundle IDs and filenames in a flat asset table.
      // These chunks can be imported after the first message, when a discovery
      // worker cannot observe the call. Read the declared table without running
      // its registration function or arbitrary JavaScript/JSON expressions.
      if(member(callee)==='register'&&node.arguments[0]?.type==='CallExpression'&&member(node.arguments[0].callee)==='getBundleURL'){
        const argument=node.arguments[1];let assets;
        if(argument?.type==='CallExpression'&&member(argument.callee)==='parse'&&argument.callee.object.type==='Identifier'&&argument.callee.object.name==='JSON'){
          const text=value(argument.arguments[0],scope);
          if(typeof text==='string')try{assets=JSON.parse(text);}catch{}
        }else if(argument?.type==='ArrayExpression')assets=argument.elements.map(item=>value(item,scope));
        if(Array.isArray(assets)&&assets.length%2===0&&assets.every(item=>typeof item==='string')){
          for(let i=1;i<assets.length;i+=2){
            if(!/\.(?:m?js)(?:[?#]|$)/i.test(assets[i]))continue;
            try{urls.add(new URL(assets[i],scriptURL).href);}catch{}
          }
        }
      }
      const imports = callee.type === "Identifier" && callee.name === "importScripts" || callee.type === "MemberExpression" &&
        (callee.computed ? callee.property.value === "importScripts" : callee.property.name === "importScripts");
      if (imports&&!asynchronous.has(node)) for (const argument of node.arguments) {
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

export async function prefetch_worker_scripts(source, base, fetch, cache = new Map(), source_urls=new Map(), scriptURL=base,{asyncLoaders=false,staticAMD=false}={}) {
  const queue = [{source,url:scriptURL,amdURL:scriptURL}];
  // Static AMD discovery is for known dual document/worker transports. Other
  // service-worker scripts retain the existing synchronous discovery behavior.
  if(staticAMD)try{staticAMD=asynchronous_worker_imports(parse(source,{ranges:true,webcompat:true,next:true})).size>0;}catch{staticAMD=false;}
  if(!cache.has(scriptURL))cache.set(scriptURL,source);
  if(!source_urls.has(scriptURL))source_urls.set(scriptURL,scriptURL);
  let dynamic = false;
  while (queue.length) {
    const entry=queue.shift();
    const next = worker_imports(entry.source, base,{scriptURL:entry.url,asyncLoaders,staticAMD,amdURL:entry.amdURL});
    dynamic ||= next.dynamic;
    for (const url of next.urls) {
      if (cache.has(url)) continue;
      cache.set(url, false);
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const text = await response.text();
        cache.set(url, text);
        const final_url=response.url||url;
        source_urls.set(url,final_url);
        queue.push({source:text,url:final_url,amdURL:url});
      } catch {}
    }
  }
  return {cache, dynamic,source_urls};
}
