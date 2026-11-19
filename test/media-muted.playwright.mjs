import assert from 'node:assert/strict';

export async function verifyMediaMuted(page){
  const origin='https://media-muted.test';
  const snapshot='Array.from(document.querySelectorAll("audio,video"),media=>({id:media.id,muted:media.muted,defaultMuted:media.defaultMuted}))';
  const fixtures={
    '/initial':'<!doctype html><body><video id="video" muted autoplay></video><audio id="audio" muted></audio><video id="false-value" muted="false"></video><video id="loud"></video><video id="override" muted></video><script>window.initialMuted='+snapshot+';document.getElementById("override").muted=false;</script><p>Parser continuation</p>',
    '/written':'<!doctype html><body><script>document.write(\'<audio id="written" muted></audio>\');window.writtenMuted=document.getElementById("written").muted;document.getElementById("written").muted=false;document.write("<p>Another write</p>");</script>'
  };
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:fixtures[new URL(route.request().url()).pathname]||''}));
  await page.evaluate(({origin,fixtures})=>{
    const fetch=sandstone.network.session.fetch;
    sandstone.network.session.fetch=(url,...args)=>new URL(url).origin===origin?Promise.resolve(new Response(fixtures[new URL(url).pathname]||'',{headers:{'Content-Type':'text/html'}})):fetch.call(sandstone.network.session,url,...args);
  },{origin,fixtures});
  const read=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const compare=async(path,source)=>{
    const outcomes=[];
    for(const proxy of [false,true]){
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+path);else await native.goto(origin+path);
      outcomes.push(JSON.parse(await read(proxy,'JSON.stringify('+source+')')));
    }
    assert.deepEqual(outcomes[1],outcomes[0],path+' muted media parity');
    return outcomes[0];
  };
  try{
    const initial=await compare('/initial','({initial:initialMuted,current:'+snapshot+'})');
    assert.deepEqual(initial.initial.map(media=>media.muted),[true,true,true,false,true]);
    assert.equal(initial.current.at(-1).muted,false);
    await compare('/written','({initial:writtenMuted,current:'+snapshot+'})');
    await compare('/initial',`(()=>{
      const media=document.createElement('video'),states=[];
      const save=()=>states.push([media.muted,media.defaultMuted]);
      save();media.setAttribute('muted','');save();media.muted=true;media.removeAttribute('muted');save();media.defaultMuted=true;save();media.muted=false;save();
      return states;
    })()`);
    await compare('/initial',`(()=>{
      const host=document.createElement('div');host.innerHTML='<video muted></video>';
      const range=document.createRange();range.selectNodeContents(document.body);
      const fragment=range.createContextualFragment('<audio muted></audio>');
      return [host.firstChild.muted,fragment.firstChild.muted];
    })()`);
    return ['Parser-created audio/video initialize mutedness before scripts run','Parser continuation and document.write retain authored muted property overrides','Dynamic muted attributes retain native defaultMuted/property separation','Inner HTML and contextual fragments preserve native muted initialization'];
  }finally{await native.close();}
}
