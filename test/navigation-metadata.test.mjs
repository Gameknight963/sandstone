import test from 'node:test';
import assert from 'node:assert/strict';
import {NavigationMetadata} from '../src/host/navigation_metadata.mjs';
import {NavigationHistory} from '../src/history.mjs';

const metadata={source:'https://source.test/',site:'cross-site',user:false,opaque:false};
test('Navigation receipts retain private attachments and release discarded reservations',()=>{
  let now=0,next=0,released=0;const owner={token:'owner'};
  const broker=new NavigationMetadata(()=>owner.token,{nonce:()=>String(++next),now:()=>now,limit:1,ttl:10});
  const scope=broker.capture('parent','child'),attachment={release:()=>released++};
  const first=broker.issue(scope,'https://target.test/',metadata,attachment);
  broker.issue(scope,'https://target.test/',metadata,attachment);assert.equal(released,1);assert.equal(broker.claim(first,'parent','child','https://target.test/'),undefined);
  const receipt=broker.issue(scope,'https://target.test/',metadata,attachment);
  const result=broker.take(receipt,'parent','child','https://target.test/');assert.equal(result.attachment,attachment);assert.deepEqual(result.metadata,metadata);assert.equal('attachment' in result.metadata,false);
  const expired=broker.issue(scope,'https://target.test/',metadata,attachment);now=10;
  assert.equal(broker.take(expired,'parent','child','https://target.test/'),undefined);assert.equal(released,3);
});
test('Navigation receipts only authorize their frame, URL and current parent document once',()=>{
  const owners=new Map([['parent','document-1'],['other','document-2']]);
  const broker=new NavigationMetadata(id=>owners.get(id),{nonce:()=> 'receipt'});
  const scope=broker.capture('parent','child'),token=broker.issue(scope,'https://target.test/page',metadata);
  assert.equal(broker.claim(token,'other','child','https://target.test/page'),undefined);
  assert.equal(broker.claim(token,'parent','different','https://target.test/page'),undefined);
  assert.equal(broker.claim(token,'parent','child','https://target.test/other'),undefined);
  assert.deepEqual(broker.claim(token,'parent','child','https://target.test/page'),metadata);
  assert.equal(broker.claim(token,'parent','child','https://target.test/page'),undefined);
  broker.issue(scope,'https://target.test/page',metadata);
  owners.set('parent','document-3');
  assert.equal(broker.issue(scope,'https://target.test/page',metadata),undefined);
  const missing=broker.capture('missing','child');owners.set('missing','document-4');
  assert.equal(broker.issue(missing,'https://target.test/page',metadata),undefined);
  assert.equal(broker.claim(token,'parent','child','https://target.test/page'),undefined);
  assert.equal(broker.claim({site:'none'},'parent','child','https://target.test/page'),undefined);
});

test('Pending navigation receipts expire, remain bounded and snapshot host metadata',()=>{
  let now=0,sequence=0;
  const broker=new NavigationMetadata(()=> 'document',{now:()=>now,nonce:()=>String(++sequence),limit:2,ttl:10});
  const first=broker.issue(broker.capture('parent','first'),'https://target.test/',metadata);
  const mutable={...metadata},second=broker.issue(broker.capture('parent','second'),'https://target.test/',mutable);
  mutable.site='none';
  const third=broker.issue(broker.capture('parent','third'),'https://target.test/',metadata);
  assert.equal(broker.claim(first,'parent','first','https://target.test/'),undefined);
  const saved=broker.claim(second,'parent','second','https://target.test/');
  assert.equal(saved.site,'cross-site');assert.equal(Object.isFrozen(saved),true);
  now=10;assert.equal(broker.claim(third,'parent','third','https://target.test/'),undefined);
});

test('History retains host request metadata independently of authored state and public snapshots',()=>{
  const history=new NavigationHistory();
  const mutable={...metadata};
  history.navigate('https://target.test/page',{request_metadata:mutable});
  mutable.site='none';
  assert.equal(history.current.request_metadata.site,'cross-site');
  history.mutate('push',{request_metadata:{site:'none'}},'https://target.test/page?next');
  assert.deepEqual(history.current.request_metadata,{source:'https://target.test/',site:'same-origin',user:false,opaque:false});
  assert.equal(Object.isFrozen(history.current.request_metadata),true);
  assert.equal('request_metadata' in history.snapshot(),false);
  history.navigate('https://elsewhere.test/');
  history.go(-1);
  assert.equal(history.current.request_metadata.site,'same-origin');
});
