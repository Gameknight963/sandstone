import assert from 'node:assert/strict';

const origin='https://image-loads.test';
const image=(source,extra='')=>'<img id="image" src="'+source+'" onload="imageEvents.loaded.push(this.id)" onerror="imageEvents.errors.push(this.id);'+extra+'">';
const cases=[
  ['failed image before parsing finishes',image('/missing.png')+'<script src="/barrier.js"></script>'],
  ['failed srcset before parsing finishes','<img id="image" srcset="/missing.png 1x" onerror="imageEvents.errors.push(this.id)"><script src="/barrier.js"></script>'],
  ['failed picture source before parsing finishes','<picture><source srcset="/missing.png 1x"><img id="image" onerror="imageEvents.errors.push(this.id)"></picture><script src="/barrier.js"></script>'],
  ['successful image before parsing finishes',image('/valid.svg')+'<script src="/barrier.js"></script>'],
  ['superseded failure cannot finish the replacement image',image('/slow-missing.png')+'<script src="/switch.js"></script>'],
  ['source removal before parsing finishes',image('/slow-valid.svg')+'<script src="/remove.js"></script>'],
  ['error handler fallback after DOMContentLoaded',image('/late-missing.png','this.src=\'/slow-valid.svg\';')],
  ['source removal after DOMContentLoaded',image('/slow-valid.svg')+'<script>setTimeout(()=>document.getElementById("image").removeAttribute("src"),30);</script>'],
  ['image created by DOMContentLoaded','<script>addEventListener("DOMContentLoaded",()=>{const image=new Image();image.id="dynamic";image.onload=()=>imageEvents.loaded.push(image.id);image.src="/slow-valid.svg";document.body.append(image);});</script>'],
  ['image created by another image load handler',image('/valid.svg','') .replace('imageEvents.loaded.push(this.id)','imageEvents.loaded.push(this.id);const child=new Image();child.id=\'child\';child.onload=()=>imageEvents.loaded.push(child.id);child.src=\'/slow-valid.svg\';document.body.append(child)')]
];
const setup='<script>globalThis.imageEvents={errors:[],loaded:[]};addEventListener("load",()=>{globalThis.imageLoadSnapshot={errors:imageEvents.errors.slice().sort(),loaded:imageEvents.loaded.slice().sort(),state:document.readyState,images:Array.from(document.images,image=>({complete:image.complete,width:image.naturalWidth}))};});</script>';
const resources=Object.fromEntries(cases.map(([name,body],index)=>['/case/'+index,{body:'<!doctype html><body>'+setup+body,type:'text/html;charset=utf-8'}]));
Object.assign(resources,{
  '/missing.png':{body:'missing',type:'image/png',status:404},
  '/late-missing.png':{body:'missing',type:'image/png',status:404,delay:50},
  '/slow-missing.png':{body:'missing',type:'image/png',status:404,delay:100},
  '/valid.svg':{body:'<svg xmlns="http://www.w3.org/2000/svg" width="9" height="3"/>',type:'image/svg+xml'},
  '/slow-valid.svg':{body:'<svg xmlns="http://www.w3.org/2000/svg" width="9" height="3"/>',type:'image/svg+xml',delay:150},
  '/barrier.js':{body:'globalThis.barrierDone=true;',type:'text/javascript',delay:100},
  '/switch.js':{body:'document.getElementById("image").src="/slow-valid.svg";',type:'text/javascript',delay:30},
  '/remove.js':{body:'document.getElementById("image").removeAttribute("src");',type:'text/javascript',delay:30}
});

export async function verifyImageLoads(page){
  const native=await page.context().newPage(),passed=[],direct=[];
  await native.route('**/*',async route=>{
    const resource=resources[new URL(route.request().url()).pathname]||{body:'',type:'text/html'};
    if(resource.delay)await new Promise(resolve=>setTimeout(resolve,resource.delay));
    try{await route.fulfill({body:resource.body,contentType:resource.type,status:resource.status||200,headers:{'Cache-Control':'no-store'}});}catch{}
  });
  const onRequest=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};page.on('request',onRequest);
  await page.evaluate(resources=>{
    globalThis.imageLoadTest={previous:sandstone.network.session.fetch};
    sandstone.network.session.fetch=async url=>{
      const resource=resources[new URL(url).pathname]||{body:'',type:'text/html'};
      if(resource.delay)await new Promise(resolve=>setTimeout(resolve,resource.delay));
      const response=new Response(resource.body,{status:resource.status||200,headers:{'Content-Type':resource.type,'Cache-Control':'no-store'}});Object.defineProperty(response,'url',{value:url});return response;
    };
  },resources);
  try{
    for(const [index,[name]] of cases.entries()){
      const url=origin+'/case/'+index;await native.goto(url);const expected=await native.evaluate(()=>imageLoadSnapshot);
      let timer;
      try{await Promise.race([page.evaluate(url=>main_frame.navigate_to(url),url),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Image load completion timed out: '+name)),5000);})]);}
      finally{clearTimeout(timer);}
      const actual=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify(imageLoadSnapshot)')));
      assert.deepEqual(actual,expected,name);passed.push('Document load follows native '+name);
    }
    assert.deepEqual(direct,[],'Image loading must stay behind the relay');return passed;
  }finally{await page.evaluate(()=>{sandstone.network.session.fetch=imageLoadTest.previous;delete globalThis.imageLoadTest;});page.off('request',onRequest);await native.close();}
}
