import {parse,parseFragment,serializeOuter,defaultTreeAdapter as tree} from 'parse5';

const html='http://www.w3.org/1999/xhtml';
const attributes=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'attributes').get;
const parent=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'parentElement').get;
const get=globalThis.Element?.prototype.getAttribute,remove=globalThis.Element?.prototype.removeAttribute;
const text=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'textContent').set;
let sequence=0;

export function parsing_context(context){
  let element=context?.nodeType===1?context:context?.parentElement;
  if(!element||element.namespaceURI===html&&element.localName==='html')return tree.createElement('body',html,[]);
  const convert=node=>tree.createElement(node.localName,node.namespaceURI,[...attributes.call(node)].map(attribute=>({
    name:attribute.localName,value:attribute.value,namespace:attribute.namespaceURI||undefined,prefix:attribute.prefix||undefined
  })));
  const result=convert(element);let ancestor=result;
  while((element=parent.call(element))){const next=convert(element);tree.appendChild(next,ancestor);ancestor=next;}
  return result;
}

// Inert documents have scripting disabled. Replace actual HTML noscript nodes
// with empty placeholders while native parsing handles every other token, then
// restore the raw text a scripting-enabled document would have produced.
export function scripting_html(context,value,document=false){
  if(!/<noscript[\t\n\f\r />]/i.test(value))return {value,restore(){}};
  const options={scriptingEnabled:true,sourceCodeLocationInfo:true};
  const parsed=document?parse(value,options):parseFragment(parsing_context(context),value,options);
  let marker;
  do{marker='data-sandstone-noscript-'+sequence++;}while(value.toLowerCase().includes(marker));
  const edits=[],contents=[],pending=[parsed];
  while(pending.length){
    const node=pending.pop();
    if(node.tagName==='noscript'&&node.namespaceURI===html&&node.sourceCodeLocation){
      const index=contents.length;contents.push(node.childNodes.map(child=>child.value||'').join(''));
      const replacement={...node,attrs:[...node.attrs,{name:marker,value:String(index)}],childNodes:[]};
      edits.push({start:node.sourceCodeLocation.startOffset,end:node.sourceCodeLocation.endOffset,value:serializeOuter(replacement)});
    }else{
      for(const child of node.childNodes||[])pending.push(child);
      if(node.content)pending.push(node.content);
    }
  }
  edits.sort((a,b)=>b.start-a.start);
  for(const edit of edits)value=value.slice(0,edit.start)+edit.value+value.slice(edit.end);
  return {value,restore(fragment){
    const pending=[fragment];
    while(pending.length){
      const root=pending.pop();
      for(const element of root.querySelectorAll('['+marker+']')){
        const value=contents[Number(get.call(element,marker))];
        remove.call(element,marker);text.call(element,value);
      }
      for(const template of root.querySelectorAll('template'))if(template instanceof HTMLTemplateElement)pending.push(template.content);
    }
  }};
}
