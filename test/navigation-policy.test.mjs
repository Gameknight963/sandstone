import test from 'node:test';
import assert from 'node:assert/strict';
import {can_navigate,navigation_sandbox} from '../src/navigation_policy.mjs';
function tree(){
  const root={id:'root',origin:'https://a.test'},parent={id:'parent',parent_id:'root',origin:'https://b.test'},child={id:'child',parent_id:'parent',origin:'https://b.test'},other={id:'other',parent_id:'root',origin:'https://a.test'};
  return {root,parent,child,other};
}
test('Navigation permits descendants and matching-origin ancestors but blocks unrelated intermediate ancestors',()=>{
  const frames=tree();
  assert.equal(can_navigate(frames.root,frames.child,frames),true);
  assert.equal(can_navigate(frames.child,frames.parent,frames),true);
  frames.parent.origin='https://a.test';
  assert.equal(can_navigate(frames.child,frames.parent,frames,{sticky:true}),false);
  frames.child.origin='https://a.test';
  assert.equal(can_navigate(frames.child,frames.parent,frames),true);
});
test('Cross-origin top navigation requires activation while matching-origin navigation does not',()=>{
  const frames=tree();
  assert.equal(can_navigate(frames.child,frames.root,frames),false);
  assert.equal(can_navigate(frames.child,frames.root,frames,{sticky:true}),true);
  frames.child.origin='https://a.test';
  assert.equal(can_navigate(frames.child,frames.root,frames),true);
});
test('Sandbox flags inherit, recognize ASCII case and distinguish transient top navigation grants',()=>{
  const frames=tree();
  frames.child.navigation_sandbox=navigation_sandbox(undefined,'ALLOW-SCRIPTS allow-top-navigation-by-user-activation');
  assert.equal(can_navigate(frames.child,frames.root,frames,{sticky:true}),false);
  assert.equal(can_navigate(frames.child,frames.root,frames,{sticky:true,transient:true}),true);
  frames.parent.navigation_sandbox=navigation_sandbox(undefined,'allow-scripts');
  frames.child.navigation_sandbox=navigation_sandbox(frames.parent.navigation_sandbox,'allow-top-navigation');
  assert.equal(can_navigate(frames.child,frames.root,frames,{sticky:true,transient:true}),false);
  frames.child.navigation_sandbox=navigation_sandbox(undefined,'ALLOW-TOP-NAVIGATION');
  assert.equal(can_navigate(frames.child,frames.root,frames),true);
});
test('Sandboxed sibling navigation is denied while descendants remain navigable',()=>{
  const frames=tree();
  frames.parent.navigation_sandbox=navigation_sandbox(undefined,'allow-same-origin');
  frames.other.origin=frames.parent.origin;
  assert.equal(can_navigate(frames.parent,frames.other,frames),false);
  assert.equal(can_navigate(frames.parent,frames.child,frames),true);
});

test('Origin sandbox restrictions inherit and cannot be removed by a descendant allow-same-origin token',()=>{
  assert.equal(navigation_sandbox().origin,false);
  assert.equal(navigation_sandbox(undefined,'').origin,true);
  assert.equal(navigation_sandbox(undefined,'ALLOW-SCRIPTS ALLOW-SAME-ORIGIN').origin,false);
  const restricted=navigation_sandbox(undefined,'allow-scripts');
  assert.equal(navigation_sandbox(restricted,'allow-scripts allow-same-origin').origin,true);
  assert.equal(navigation_sandbox(restricted,null).origin,true);
});
