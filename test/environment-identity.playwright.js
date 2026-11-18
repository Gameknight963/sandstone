async page=>{
  const url='https://environment-identity.test/',html='<!doctype html><body>Environment identity fixture';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const source=`(()=>{
    const inspect=view=>({window:view.constructor===view.Window,document:view.document.constructor===view.HTMLDocument,windowName:view.constructor.name,documentName:view.document.constructor.name,prototype:Object.getPrototypeOf(view).constructor===view.constructor,documentPrototype:Object.getPrototypeOf(view.document).constructor===view.document.constructor,defaultView:view.document.defaultView.constructor===view.Window,owner:view.document.body.ownerDocument.constructor===view.HTMLDocument});
    const root=inspect(window),browser=self.Object===Object&&self.constructor===Window&&self.document===document&&self.location===location&&self.history===history&&self.navigator===navigator;
    const frame=document.createElement('iframe');document.body.append(frame);const child=inspect(frame.contentWindow);frame.remove();
    function WindowPatch(){}function DocumentPatch(){}
    window.constructor=WindowPatch;document.constructor=DocumentPatch;
    const patched={window:window.constructor===WindowPatch,document:document.constructor===DocumentPatch,reflectedWindow:Object.getOwnPropertyDescriptor(window,'constructor').value===WindowPatch,reflectedDocument:Object.getOwnPropertyDescriptor(document,'constructor').value===DocumentPatch};
    delete window.constructor;delete document.constructor;
    return JSON.stringify({root,browser,child,patched,restored:inspect(window)});
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(({url,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>String(target).startsWith(url)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{url,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Environment identity parity: '+JSON.stringify({expected,actual}));
    return ['Window and Document constructors retain native identity across root and same-origin frame views','Browser feature checks and constructor overrides preserve native behavior'];
  }finally{await context.close();}
}
