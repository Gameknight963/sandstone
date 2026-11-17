async page=>{
  const source=`(()=>{
    window.attrEvents=[];
    const results=[],body=label=>'window.attrEvents.push([this.id,event.type,location.hostname,'+JSON.stringify(label)+']);return false;';
    const button=id=>{const node=document.createElement('button');node.id=id;document.body.append(node);return node;};
    const click=(node,label)=>{
      const event=new MouseEvent('click',{bubbles:true,cancelable:true}),dispatched=node.dispatchEvent(event);
      results.push({label,raw:node.getAttribute('onclick'),present:node.hasAttribute('onclick'),handler:typeof node.onclick,dispatched,canceled:event.defaultPrevented});
    };
    click(document.getElementById('initial'),'initial');
    const node=button('dynamic');node.setAttribute('onCLICK',body('first'));click(node,'set');
    node.setAttribute('onclick',body('second'));click(node,'replace');
    node.onclick=function(event){attrEvents.push([this.id,event.type,location.hostname,'property']);return false;};
    node.toggleAttribute('onclick',true);click(node,'property-toggle');
    node.setAttribute('onclick',body('second'));click(node,'same-value-reset');
    node.onclick=null;click(node,'property-null');
    node.removeAttribute('onclick');click(node,'remove');
    node.setAttributeNS(null,'onclick',body('namespace'));click(node,'namespace');
    node.getAttributeNode('onclick').value=body('value');click(node,'value');
    node.getAttributeNode('onclick').nodeValue=body('nodeValue');click(node,'nodeValue');
    node.getAttributeNode('onclick').textContent=body('textContent');click(node,'textContent');
    const attribute=document.createAttribute('onclick');attribute.value=body('attribute-node');node.setAttributeNode(attribute);click(node,'attribute-node');
    const replacement=document.createAttribute('onclick');replacement.value=body('named-map');node.attributes.setNamedItem(replacement);click(node,'named-map');
    const clone=node.cloneNode(true);clone.id='clone';clone.click();results.push({label:'clone',raw:clone.getAttribute('onclick'),handler:typeof clone.onclick});
    node.attributes.removeNamedItem('onclick');click(node,'named-remove');
    const html=document.createElement('div');html.innerHTML='<button id="fragment" onclick="window.attrEvents.push([this.id,event.type,location.hostname]);return false;">Fragment</button>';document.body.append(html);
    click(html.firstElementChild,'fragment');results.push({label:'serialization',html:html.innerHTML});
    const same=body('coercion');node.setAttribute('onclick',same);
    let conversions=0;node.setAttribute('onclick',{toString(){conversions++;node.onclick=()=>{attrEvents.push(['unexpected-property']);};return same;}});click(node,'coercion');results.push({label:'conversion-count',conversions});
    class EventButton extends HTMLElement{
      static get observedAttributes(){return ['onclick'];}
      attributeChangedCallback(name,old,value){if(value){this.click();this.onclick=function(event){attrEvents.push([this.id,event.type,location.hostname,'custom-property']);return false;};}}
    }
    customElements.define('event-attribute-button',EventButton);const custom=document.createElement('event-attribute-button');custom.id='custom';document.body.append(custom);
    custom.setAttribute('onclick',body('custom-attribute'));click(custom,'custom-callback');
    class MaskedButton extends HTMLElement{get onclick(){return 'masked';}set onclick(value){attrEvents.push(['unexpected-setter']);}}
    customElements.define('event-attribute-masked',MaskedButton);const masked=document.createElement('event-attribute-masked');masked.id='masked';document.body.append(masked);
    masked.setAttribute('onclick',body('masked-attribute'));click(masked,'masked-handler');
    const form=document.createElement('form');form.id='masked-form';form.innerHTML='<input name="namespaceURI"><input name="ownerDocument"><input name="attributes"><input name="onclick">';document.body.append(form);
    form.setAttribute('onCLICK',body('form-attribute'));click(form,'masked-form');
    const failures=[];for(const method of ['setAttribute','setAttributeNS','removeAttribute','removeAttributeNS','toggleAttribute'])try{node[method]();}catch(error){failures.push(error.name);}
    results.push({label:'arity',failures});
    return JSON.stringify({results,events:attrEvents});
  })()`;
  const html='<!doctype html><body><button id="initial" onclick="window.attrEvents.push([this.id,event.type,location.hostname]);return false;">Initial</button>';
  const url='https://fixture.test/event-attributes/page',native=await page.context().newPage();
  await native.route(url,route=>route.fulfill({contentType:'text/html',body:html}));
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(async({url,html})=>{main_frame.special_pages[url]=html;await main_frame.navigate_to(url);},{url,html});
    const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Event attribute parity: '+JSON.stringify({expected,actual}));
    return ['Initial and dynamic event attributes retain virtual globals and native cancellation','Attribute nodes/maps, cloning, serialization and property overrides','Custom-element callbacks and reentrant event-attribute coercion'];
  }finally{await native.close();}
}
