export function cache_fixture(){
  const requests=[],versions=new Map();
  return {
    handle(request,response,url){
      if(!url.pathname.startsWith('/cache/'))return false;
      const client=url.searchParams.get('client'),item=url.searchParams.get('item')||'',kind=url.searchParams.get('kind')||'fresh';
      if(url.pathname.endsWith('/page')){
        response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Set-Cookie':'cache_session=one; SameSite=Lax; Path=/'});response.end('<!doctype html><body>HTTP cache fixture');return true;
      }
      const key=client+':'+item,version=versions.get(key)||1;
      const language=request.headers['x-language']??'';
      requests.push({client,item,method:request.method,etag:request.headers['if-none-match']||null,modified:request.headers['if-modified-since']||null,
        cache:request.headers['cache-control']||null,pragma:request.headers.pragma||null,language});
      if(request.method==='POST'){
        versions.set(key,version+1);response.writeHead(204);response.end();return true;
      }
      const headers={'Content-Type':'application/json',ETag:'"'+item+':'+version+':'+language+'"',
        'Last-Modified':'Wed, 01 Jan 2025 00:00:00 GMT',
        'Cache-Control':kind==='stale'?'max-age=0':kind==='no-cache'?'no-cache':kind==='no-store'?'no-store':'max-age=60'};
      if(kind==='vary')headers.Vary='X-Language';
      if(kind==='wild')headers.Vary='*';
      if(url.pathname.endsWith('/document'))headers['Content-Type']='text/html';
      if(request.headers['if-none-match']===headers.ETag){response.writeHead(304,{...headers,'X-Revalidated':'yes'});response.end();return true;}
      response.writeHead(200,headers);
      response.end(request.method==='HEAD'?undefined:url.pathname.endsWith('/document')?'<!doctype html><body><script>window.documentVersion='+version+';</script>':JSON.stringify({item,version,language}));return true;
    },
    values(client){return requests.filter(value=>value.client===client).map(({client,...value})=>value);},
    bump(client,item){const key=client+':'+item;versions.set(key,(versions.get(key)||1)+1);}
  };
}

export const cache_script=client=>`(async()=>{
  const results=[];
  const url=(item,kind='fresh')=>'/cache/data?client='+${JSON.stringify(client)}+'&item='+item+'&kind='+kind;
  const read=async(item,kind,options={})=>{
    try{
      const response=await fetch(url(item,kind),options);
      results.push({item,status:response.status,body:await response.text(),revalidated:response.headers.get('x-revalidated')});
    }catch(error){results.push({item,error:error.name});}
  };
  await read('fresh');await read('fresh');
  await read('stale','stale');await read('stale','stale');
  await read('stale','stale',{cache:'force-cache'});
  await read('fresh','fresh',{cache:'reload'});
  await read('fresh','fresh',{cache:'no-store'});await read('fresh');
  await read('fresh','fresh',{cache:'no-cache'});
  await read('fresh','fresh',{cache:'only-if-cached',mode:'same-origin'});
  await read('missing','fresh',{cache:'only-if-cached',mode:'same-origin'});
  await read('private','no-store');await read('private','no-store');
  await read('validate','no-cache');await read('validate','no-cache');
  for(const language of ['en','fr','en','fr'])await read('vary','vary',{headers:{'X-Language':language}});
  await read('wild','wild');await read('wild','wild');
  await read('manual','stale');await read('manual','stale',{headers:{'If-None-Match':'"manual:1:"'}});
  await read('mutate');await fetch(url('mutate'),{method:'POST'});await read('mutate');
  const head=await fetch(url('head'),{method:'HEAD'});results.push({item:'head',nullBody:head.body===null,status:head.status});
  const cachedHead=await fetch(url('head'),{method:'HEAD'});results.push({item:'head',nullBody:cachedHead.body===null,status:cachedHead.status});
  await read('head');
  return JSON.stringify(results);
})()`;
