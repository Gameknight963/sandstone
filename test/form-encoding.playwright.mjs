import {listen_browser_server} from './browser-server.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

const initialize=function(){
  globalThis.form=document.getElementById('subject');globalThis.button=document.getElementById('send');
  document.getElementById('text').value=String.fromCodePoint(0x0422,0x0435,0x0441,0x0442,32,0x65e5,0x672c,32,0x96ea,32,0x1f600,10,0xe9);
  globalThis.snapshots=[];globalThis.snapshot=data=>Array.from(data,([name,value])=>[name,typeof value==='string'?value:{file:value.name,size:value.size,type:value.type}]);
  form.addEventListener('formdata',event=>snapshots.push(snapshot(event.formData)));
};
const html='<!doctype html><iframe name="sink"></iframe><form id="subject" action="/received" method="post" target="sink">'+
  '<input name="_charset_" value="UTF-8"><input type="hidden" name="_charset_" value="ignored">'+
  '<textarea id="text" name="text" dirname="_charset_"></textarea><input type="hidden" name="_charset_">'+
  '<select name="_charset_" multiple><option selected>first</option><option selected disabled>skip</option><option selected>second</option></select>'+
  '<input type="hidden" name="_charset_" disabled><input type="checkbox" name="_charset_"><input type="checkbox" name="_charset_" checked value="checked">'+
  '<input type="file" name="_charset_"><input type="hidden" name="_charset_"><input type="hidden" name="_CHARSET_">'+
  '<input name="elements" value="masked"><button id="send" name="_charset_" value="submitter">Send</button></form><script>('+initialize.toString()+')();</script>';
const normalize=(path,type,body)=>{
  const boundary=/boundary=(?:"([^"]*)"|([^;]*))/i.exec(type);
  return {path,type:type.split(';')[0],body:boundary?body.replaceAll(boundary[1]||boundary[2],'BOUNDARY'):body};
};

export async function verifyFormEncoding(page,{batch=0,batches=1}={}){
  let requests=[];
  const server=createServer((request,response)=>{
    const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
      if(request.url.startsWith('/received'))requests.push(normalize(request.url,request.headers['content-type']||'',Buffer.concat(chunks).toString('latin1')));
      response.writeHead(200,{'Content-Type':request.url==='/form'?'text/html;charset=windows-1251':'text/html;charset=utf-8'});
      response.end(request.url==='/form'?html:'<!doctype html>Received');
    });
  });
  await listen_browser_server(server);
  const origin='http://127.0.0.1:'+server.address().port,native=await page.context().newPage(),direct=[];
  const block=request=>{direct.push(request.request().url());return request.abort();};await page.route(/^https?:/,block);
  const cases=[];
  for(const charset of ['', 'UTF-8','Shift_JIS','GBK','Big5','EUC-KR','ISO-2022-JP','GB18030','unknown windows-1252','UTF-16LE'])for(const enctype of ['application/x-www-form-urlencoded','text/plain','multipart/form-data'])cases.push({name:charset+' '+enctype,charset,enctype});
  cases.push({name:'legacy GET',method:'get'},{name:'UTF-8 GET',method:'get',charset:'UTF-8'},
    {name:'prototype submit',invoke:'HTMLFormElement.prototype.submit.call(form)'},
    {name:'formdata mutation wins',setup:'form.addEventListener("formdata",event=>event.formData.set("_charset_","authored"))'},
    {name:'closed shadow form',setup:'const host=document.createElement("div");document.body.append(host);host.attachShadow({mode:"closed"}).append(form)'},
    {name:'custom form-associated entries',setup:'customElements.define("charset-field",class extends HTMLElement{static formAssociated=true;constructor(){super();const internals=this.attachInternals(),data=new FormData();data.append("_charset_","UTF-8");data.append("_charset_","custom");internals.setFormValue(data);data.append("_charset_","late");}});form.prepend(document.createElement("charset-field"));'},
    {name:'scalar custom form-associated entry',setup:'customElements.define("charset-field",class extends HTMLElement{static formAssociated=true;constructor(){super();this.attachInternals().setFormValue("UTF-8");}});const field=document.createElement("charset-field");field.setAttribute("name","_charset_");form.prepend(field);'},
    {name:'unselected submit dirname',setup:'const input=document.createElement("input");input.type="submit";input.name="other";input.setAttribute("dirname","_charset_");form.prepend(input);'},
    {name:'disabled fieldset legend and datalist',setup:'const fields=document.createElement("fieldset");fields.disabled=true;fields.innerHTML="<legend><input type=hidden name=_charset_></legend><input type=hidden name=_charset_>";form.prepend(fields);const list=document.createElement("datalist");list.innerHTML="<input type=hidden name=_charset_>";form.prepend(list);'},
    {name:'native file subclass metadata',enctype:'multipart/form-data',setup:'class Upload extends File{get name(){return "authored"}get type(){return "authored/type"}}form.addEventListener("formdata",event=>event.formData.append("subclass",new Upload(["payload"],"original.txt",{type:"text/plain"})));'});
  try{
    await page.evaluate(({origin,html})=>{
      const previous=sandstone.network.session.fetch.bind(sandstone.network.session);globalThis.formEncodingRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        const target=new URL(url);if(target.origin!==origin)return previous(url,options);
        if(target.pathname==='/received'){
          const type=new Headers(options.headers).get('content-type')||'',boundary=/boundary=(?:"([^"]*)"|([^;]*))/i.exec(type);
          let body=options.body?Array.from(new Uint8Array(options.body),byte=>String.fromCharCode(byte)).join(''):'';
          if(boundary)body=body.replaceAll(boundary[1]||boundary[2],'BOUNDARY');
          formEncodingRequests.push({path:target.pathname+target.search,type:type.split(';')[0],body});
        }
        const response=new Response(target.pathname==='/form'?html:'<!doctype html>Received',{headers:{'Content-Type':target.pathname==='/form'?'text/html;charset=windows-1251':'text/html;charset=utf-8'}});
        Object.defineProperty(response,'url',{value:url});return Promise.resolve(response);
      };
    },{origin,html});
    const run=async(proxy,example)=>{
      if(proxy)await page.evaluate(async url=>{formEncodingRequests=[];await main_frame.navigate_to(url);},origin+'/form');
      else{requests=[];await native.goto(origin+'/form');}
      const source='form.acceptCharset='+JSON.stringify(example.charset||'')+';form.enctype='+JSON.stringify(example.enctype||'application/x-www-form-urlencoded')+';form.method='+JSON.stringify(example.method||'post')+';'+
        (example.setup||'')+';form.addEventListener("formdata",event=>event.formData.append("upload",new File([Uint8Array.of(0,255,13,10)],String.fromCodePoint(0x96ea,0xe9,10,34)+".bin")));'+
        'globalThis.constructed=snapshot(new FormData(form));snapshots=[];'+(example.invoke||'form.requestSubmit(button)')+';true';
      if(proxy)await page.evaluate(source=>main_frame.eval_js(source),source);else await native.evaluate(source=>eval(source),source);
      const deadline=Date.now()+5000;let captured;
      while(!(captured=proxy?await page.evaluate(()=>formEncodingRequests):requests).length){
        if(Date.now()>deadline)throw new Error('Form encoding request timed out: '+example.name+' proxy='+proxy);
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      const result='JSON.stringify({constructed,snapshots})';
      return {events:JSON.parse(proxy?await page.evaluate(source=>main_frame.eval_js(source),result):await native.evaluate(source=>eval(source),result)),requests:captured};
    };
    for(const [index,example] of cases.entries())if(index%batches===batch)assert.deepEqual(await run(true,example),await run(false,example),'Form encoding: '+example.name);
    assert.deepEqual(direct,[],'Legacy forms bypassed the relay');
    return ['Legacy form encodings match native GET, URL-encoded, plain-text and multipart bytes','Hidden charset fields preserve duplicate fields, dirname, files, custom elements and formdata mutation semantics'];
  }finally{await native.close();await page.unroute(/^https?:/,block);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
