import assert from 'node:assert/strict';

export const authFormSites=[{id:'discord',url:'https://discord.com/login',timeout:60000,editor:true}];

export async function interactAuthForm(page,proxy,{surface,read,wait}){
  await surface.locator('input[name="email"]').fill('sandstone@example.invalid');
  await surface.locator('input[name="password"]').fill('sandstone test');
  assert.deepEqual(await read(page,proxy,'({email:document.querySelector(\'input[name="email"]\').value,password:document.querySelector(\'input[name="password"]\').value})'),{email:'sandstone@example.invalid',password:'sandstone test'});
  await read(page,proxy,'(window.liveNavigationMarker="persisted")');
  await surface.getByText('Register',{exact:true}).click();
  await wait(page,proxy,'location.pathname==="/register"&&!!document.querySelector(\'input[name="username"]\')');
  await read(page,proxy,'(history.back(),true)');
  await wait(page,proxy,'location.pathname==="/login"&&!!document.querySelector(\'input[name="email"]\')&&!document.querySelector(\'input[name="username"]\')&&document.querySelector("h1")?.textContent.trim()==="Welcome back!"');
  const clientNavigation=await read(page,proxy,'window.liveNavigationMarker==="persisted"');
  assert.equal(clientNavigation,true,'Account form navigation replaced the document');
  return {login:true,register:true,returned:true,clientNavigation};
}
