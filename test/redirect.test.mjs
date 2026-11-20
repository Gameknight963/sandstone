import test from 'node:test';
import assert from 'node:assert/strict';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';

test('Redirect chains inherit, replace and explicitly clear document fragments',async()=>{
  for(const [locations,expected] of [
    [['/middle','/end'],'https://redirect.test/end#section'],
    [['/middle#next','/end'],'https://redirect.test/end#next'],
    [['/middle#','/end'],'https://redirect.test/end'],
    [['/end?name=%23literal'],'https://redirect.test/end?name=%23literal#section'],
    [['https://other.test/end'],'https://other.test/end#section']
  ]){
    let index=0;const response=await fetch_with_cookies(async()=>index<locations.length?new Response('redirect',{status:302,headers:{location:locations[index++]}}):new Response('done'),new SiteDataStore(),'https://redirect.test/start#section',{}, {navigation:true});
    assert.equal(response.url,expected);assert.equal(response.redirected,true);assert.equal(await response.text(),'done');
  }
});

test('Invalid redirect URLs cancel unread response bodies without replacing the network error',async()=>{
  for(const location of ['http://[','data:text/html,blocked','javascript:blocked']){
    let canceled=0,requests=0;
    const transport=async()=>{requests++;return new Response(new ReadableStream({cancel(){canceled++;throw new Error('Cleanup failure');}}),{status:302,headers:{location}});};
    await assert.rejects(fetch_with_cookies(transport,new SiteDataStore(),'https://redirect.test/start'),TypeError);
    assert.equal(requests,1);assert.equal(canceled,1);
  }
});

test('Redirect body cancellation failures cannot stop a valid destination or bypass the redirect limit',async()=>{
  let requests=0,canceled=0;
  const response=()=>new Response(new ReadableStream({cancel(){canceled++;throw new Error('Cleanup failure');}}),{status:302,headers:{location:'/next'}});
  const result=await fetch_with_cookies(async()=>++requests===1?response():new Response('done'),new SiteDataStore(),'https://redirect.test/start');
  assert.equal(await result.text(),'done');assert.equal(requests,2);assert.equal(canceled,1);
  requests=0;canceled=0;
  await assert.rejects(fetch_with_cookies(async()=>{requests++;return response();},new SiteDataStore(),'https://redirect.test/start'),/Too many redirects/);
  assert.equal(requests,21);assert.equal(canceled,21);
});
