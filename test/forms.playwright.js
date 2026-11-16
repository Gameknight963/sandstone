async page => {
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  await page.evaluate(async ()=>{
    const previous=sandstone.network.session.fetch;
    globalThis.formRequests=[];
    sandstone.network.session.fetch=async (url,options)=>{
      if(!new URL(url).pathname.startsWith('/forms-fixture/')) return previous(url,options);
      formRequests.push({url,method:options.method||'GET',body:options.body ? new TextDecoder().decode(options.body):'',headers:options.headers});
      return new Response('<!doctype html><body>Submitted</body>',{headers:{'Content-Type':'text/html'}});
    };
    globalThis.formFixture=`<!doctype html><body>
      <form id="clobbered" action="/forms-fixture/post" method="post" enctype="text/plain">
        <input name="submit" value="submit-value"><input name="method" value="method-value">
        <input name="enctype" value="enctype-value"><input name="action" value="action-value">
        <input name="getAttribute" value="attribute-value"><button id="send" name="send" value="yes">Send</button>
        <input name="children"><input name="matches"><input name="attributes"><input name="style">
        <input name="addEventListener"><input name="__rewritten__">
      </form>`;
    main_frame.special_pages['https://fixture.test/forms-fixture/page']=formFixture;
    await main_frame.navigate_to('https://fixture.test/forms-fixture/page');
  });
  const reflection=JSON.parse(await evaluate(`JSON.stringify((()=>{
    const form=document.getElementById('clobbered');
    return {submit:form.submit.name,method:form.method.name,enctype:form.enctype.name,action:form.action.name,attribute:form.getAttribute.name};
  })())`));
  if(JSON.stringify(reflection)!==JSON.stringify({submit:'submit',method:'method',enctype:'enctype',action:'action',attribute:'getAttribute'})) throw new Error('Named form controls did not retain native masking: '+JSON.stringify(reflection));
  const navigate=async source=>{
    const before=await page.evaluate(()=>main_frame.navigation_id);
    await evaluate(`setTimeout(()=>{${source}},0); true`);
    await page.waitForFunction(id=>main_frame.navigation_id>id && !main_frame.is_navigating,before);
    return page.evaluate(()=>formRequests.at(-1));
  };
  const posted=await navigate(`HTMLFormElement.prototype.submit.call(document.getElementById('clobbered'));`);
  if(posted.url!=='https://fixture.test/forms-fixture/post' || posted.method!=='POST' ||
      !posted.body.includes('submit=submit-value\r\n') || !posted.body.includes('getAttribute=attribute-value\r\n') ||
      posted.body.includes('send=yes')) throw new Error('Prototype form submission failed: '+JSON.stringify(posted));
  await page.evaluate(()=>main_frame.navigate_to('https://fixture.test/forms-fixture/page'));
  const submitted=await navigate(`document.getElementById('clobbered').requestSubmit(document.getElementById('send'));`);
  if(!submitted.body.includes('send=yes\r\n') || submitted.method!=='POST') throw new Error('requestSubmit failed with masked form properties: '+JSON.stringify(submitted));
  await page.evaluate(()=>main_frame.navigate_to('https://fixture.test/forms-fixture/page'));
  const get=await navigate(`const button=document.getElementById('send'); button.setAttribute('formmethod',''); button.setAttribute('formaction','/forms-fixture/get'); document.getElementById('clobbered').requestSubmit(button);`);
  const query=new URL(get.url);
  if(get.method!=='GET' || query.pathname!=='/forms-fixture/get' || query.searchParams.get('send')!=='yes' || query.searchParams.get('method')!=='method-value') throw new Error('Submitter overrides did not use normalized defaults: '+JSON.stringify(get));
  return ['Forms with controls masking submit/method/enctype/action', 'Prototype submit and requestSubmit through the relay', 'Submitter overrides and normalized form methods'];
}
