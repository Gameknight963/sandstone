async page=>{
  const source=`(()=>{
    const results=[];
    const sample=(link,label)=>({label,tag:link.tagName,raw:link.getAttribute('href'),href:link.href,origin:link.origin,protocol:link.protocol,username:link.username,password:link.password,host:link.host,hostname:link.hostname,port:link.port,pathname:link.pathname,search:link.search,hash:link.hash,string:String(link)});
    for(const tag of ['a','area']){
      const link=document.createElement(tag);
      for(const href of [null,'','#section','../next?query=1#hash','/root','//cdn.test:8443/resource','https://u:p@other.test:444/path?q=1#old','mailto:user@test','data:text/plain,x','javascript:void(0)','http://[']){
        if(href===null)link.removeAttribute('href');else link.setAttribute('href',href);
        results.push(sample(link,'raw:'+href));
      }
      link.href='../account?old=1#first';
      for(const [key,value] of [['username','user name'],['password','p@ss'],['hostname','münich.test'],['port','8080'],['pathname','/new path'],['search','?new=yes'],['hash','next section'],['protocol','http:'],['href','/final']]){
        link[key]=value;results.push(sample(link,'set:'+key));
      }
      link.href='http://[';link.pathname='/ignored';results.push(sample(link,'invalid-setter'));
      link.removeAttribute('href');link.hash='missing';results.push(sample(link,'missing-setter'));
      const other=document.createElement(tag);other.href='/other';
      link.href='/before?old=1';
      link.pathname={toString(){void other.href;link.href='https://changed.test/after?new=1#kept';return '/coerced';}};
      results.push(sample(link,'coercion-reentrancy'));
      let symbolError;try{link.hash=Symbol('invalid');}catch(error){symbolError=error.name;}
      results.push({label:'symbol',tag,error:symbolError});
      link.href='https://fixture.test/same#fragment';
      const observer=new MutationObserver(()=>{});observer.observe(link,{attributes:true,attributeOldValue:true,attributeFilter:['href']});
      for(const [key,value] of [['hash','fragment'],['port','not-a-port'],['protocol','https:']]){
        link[key]=value;results.push({label:'mutation:'+key,tag,records:observer.takeRecords().map(record=>record.oldValue),raw:link.getAttribute('href')});
      }
      observer.disconnect();
      const dynamic=document.createElement(tag);dynamic.href='child';results.push(sample(dynamic,'before-base'));
      const base=document.createElement('base');base.href='/assets/base/';document.head.append(base);results.push(sample(dynamic,'with-base'));
      base.href='https://cdn.test/files/';results.push(sample(dynamic,'changed-base'));base.remove();
      history.replaceState(null,'','/hyperlinks/changed/deep');results.push(sample(dynamic,'history-base'));
      history.replaceState(null,'','/hyperlinks/start/path?top=1#old');
    }
    const foreign=document.implementation.createHTMLDocument('');
    const foreignBase=foreign.createElement('base');foreignBase.href='https://foreign.test/own/';foreign.head.append(foreignBase);
    const adopted=foreign.createElement('a');adopted.href='child';results.push(sample(adopted,'foreign-document'));
    document.body.append(adopted);results.push(sample(adopted,'adopted-document'));adopted.remove();
    return JSON.stringify(results);
  })()`;
  const url='https://fixture.test/hyperlinks/start/path?top=1#old';
  const native=await page.context().newPage();
  await native.route('https://fixture.test/hyperlinks/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body>Hyperlinks'}));
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(async url=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>new URL(url).pathname.startsWith('/hyperlinks/')?Promise.resolve(new Response('<!doctype html><body>Hyperlinks',{headers:{'Content-Type':'text/html'}})):previous(url,options);
      await main_frame.navigate_to(url);
    },url);
    const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Hyperlink URL parity: '+JSON.stringify({expected,actual}));
    return ['Native anchor/area URL reflection and component setters','Dynamic base/history URLs, invalid URLs and adopted links'];
  }finally{await native.close();}
}
