import {runInNewContext} from 'node:vm';
import {serialize} from 'parse5';
import {HTMLInputStream} from '../src/frame/html_input_stream.mjs';

export async function verifyHTMLInputStream(page){
  const native=await page.context().newPage(),origin='https://html-input.test';
  const script=source=>'<script>'+source.replace(/<\/script/gi,'<\\/script')+'</script>';
  const write=chunks=>chunks.map(chunk=>'document.write('+JSON.stringify(chunk)+');').join('');
  const external="events.push('external');document.write('<b id=\"downloaded\">Downloaded</b>');";
  const cases=[
    '<main>'+script(write(['<p id="written">one &am','p; two</p>'])+"events.push(!!document.getElementById('written'),!!document.getElementById('future'));" )+'<aside id="future">Future</aside></main>',
    '<main>'+script(write(['<script>events.push("inner");document.write("<i>nested</i>");</script>'])+"events.push('outer');")+'<b>Remaining</b></main>',
    '<table>'+script(write(['text<tr><td>Cell</td></tr>']))+'</table>',
    '<main>'+script(write(['<textarea>a<b>&am','p;</textarea><svg><foreignObject><p>HTML</p></foreignObject></svg>']))+'</main>',
    '<template>'+script("events.push('inert');")+'</template>'+script("events.push('active');"),
    '<main><script src="/external.js"></script><aside id="future">After download</aside></main>'
  ];
  let html;
  await native.route(origin+'/**',async route=>{
    if(new URL(route.request().url()).pathname==='/external.js'){
      await new Promise(resolve=>setTimeout(resolve,10));return route.fulfill({contentType:'text/javascript',body:external});
    }
    return route.fulfill({contentType:'text/html',body:html});
  });
  try{
    for(let index=0;index<cases.length;index++){
      html='<!doctype html><body>'+script('globalThis.events=[];')+cases[index];
      await native.goto(origin+'/'+index);
      const expected=await native.evaluate(()=>({html:new XMLSerializer().serializeToString(document.doctype)+document.documentElement.outerHTML,events}));
      const find=(node,id)=>node.attrs?.some(attribute=>attribute.name==='id'&&attribute.value===id)?node:(node.childNodes||[]).map(child=>find(child,id)).find(Boolean);
      let context;
      const execute=(source,input)=>{const previous=context.document.write;context.document.write=(...chunks)=>input.write(chunks.join(''));try{return runInNewContext(source,context);}finally{context.document.write=previous;}};
      const stream=new HTMLInputStream({onScript(node,{inTemplate},input){
        if(inTemplate)return;
        if(node.attrs.some(attribute=>attribute.name==='src'))return new Promise(resolve=>setTimeout(resolve,10)).then(()=>execute(external,input));
        execute(node.childNodes.map(child=>child.value||'').join(''),input);
      }});
      context={document:{write(...chunks){stream.write(chunks.join(''));},getElementById(id){return find(stream.document,id)||null;}}};
      stream.write(html);await stream.close();
      const actual={html:serialize(stream.document),events:[...context.events]};
      if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('HTML input differs from native document.write in case '+index+': '+JSON.stringify(actual)+' expected '+JSON.stringify(expected));
    }
    const chunks=['<!doctype html><main><script src="/external.js"></script><aside>After download</aside></main>','<footer>Later write</footer>'];
    await native.evaluate(chunks=>{globalThis.events=[];document.open();for(const chunk of chunks)document.write(chunk);document.close();},chunks);
    await native.waitForFunction(()=>document.getElementById('downloaded')&&document.querySelector('footer'));
    const expected=await native.evaluate(()=>({html:new XMLSerializer().serializeToString(document.doctype)+document.documentElement.outerHTML,events}));
    const events=[],stream=new HTMLInputStream({onScript(_node,_context,input){return new Promise(resolve=>setTimeout(resolve,10)).then(()=>{events.push('external');input.write('<b id="downloaded">Downloaded</b>');});}});
    for(const chunk of chunks)stream.write(chunk);await stream.close();
    const actual={html:serialize(stream.document),events};
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Pending-script input differs from native document.write: '+JSON.stringify(actual)+' expected '+JSON.stringify(expected));
    return ['Incremental HTML input matches native document.write for nested scripts, partial tokens, table insertion and external scripts'];
  }finally{await native.close();}
}
