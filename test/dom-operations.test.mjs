import test from 'node:test';
import assert from 'node:assert/strict';

test('HTML constructor adapters preserve inheritance and run copy hooks before instance fields',async()=>{
  function HTMLElement(value){this.value=value;this.target=new.target;}
  function HTMLDivElement(value){this.value=value;this.target=new.target;}
  Object.setPrototypeOf(HTMLDivElement,HTMLElement);
  HTMLDivElement.prototype=Object.create(HTMLElement.prototype,{constructor:{value:HTMLDivElement,writable:true,configurable:true}});
  const originals=new Map(['HTMLElement','HTMLDivElement'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  try{
    Object.assign(globalThis,{HTMLElement,HTMLDivElement});
    const {virtual_html_constructor,html_constructor_names,with_dom_access,notify_dom_access}=await import('../src/frame/dom_operations.mjs');
    const Base=virtual_html_constructor(HTMLElement),Div=virtual_html_constructor(HTMLDivElement);
    assert.equal(globalThis.HTMLElement,Base);assert.equal(globalThis.HTMLDivElement,Div);
    assert.ok(html_constructor_names.includes('HTMLElement'));assert.ok(html_constructor_names.includes('HTMLDivElement'));
    assert.equal(Object.getPrototypeOf(Div),Base);assert.equal(Base.prototype.constructor,Base);assert.equal(Div.prototype.constructor,Div);
    const events=[];
    class Component extends Div{
      field=events.push(['field',this.value]);
      constructor(){super('value');events.push(['body',this.value]);}
    }
    const element=with_dom_access(value=>events.push(['native',value.value]),()=>new Component());
    assert.deepEqual(events,[['native','value'],['field','value'],['body','value']]);
    assert.equal(element.target,Component);assert.ok(element instanceof HTMLElement);assert.ok(element instanceof Base);assert.ok(element instanceof Div);
    const failure=new Error('copy failed');
    assert.throws(()=>with_dom_access(()=>{throw failure;},()=>new Div()),error=>error===failure);
    assert.doesNotThrow(()=>notify_dom_access(element));
    const outer=[],inner=[];
    with_dom_access(value=>outer.push(value),()=>{notify_dom_access(1);with_dom_access(value=>inner.push(value),()=>notify_dom_access(2));notify_dom_access(3);});
    assert.deepEqual(outer,[1,2,3]);assert.deepEqual(inner,[2]);
  }finally{
    for(const [name,property] of originals)if(property)Object.defineProperty(globalThis,name,property);else delete globalThis[name];
  }
});
