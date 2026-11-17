import test from 'node:test';
import assert from 'node:assert/strict';
import {parse,serialize,defaultTreeAdapter as tree} from 'parse5';
import {HTMLInputStream} from '../src/frame/html_input_stream.mjs';

const text=node=>(node.childNodes||[]).map(child=>child.value||text(child)).join('');
const find=(node,tag)=>node.tagName===tag?node:(node.childNodes||[]).map(child=>find(child,tag)).find(Boolean);

test('HTML input retains tokenizer and tree state across every split, including entities, raw text and namespaces',async()=>{
  const source='<!doctype html><title>A &amp; B</title><main a="x>y"><p>one\r\ntwo &notin; &#x1f642; 🙂</p><!-- > --><textarea>a<b>&amp;</textarea><style>b::after{content:"< >"}</style><svg><foreignObject><p>HTML</p></foreignObject><![CDATA[x>y]]></svg><table>foster<tr><td>cell</table><b><i>adoption</b>tail</i></main>';
  const expected=serialize(parse(source));
  for(let split=0;split<=source.length;split++){
    const stream=new HTMLInputStream();stream.write(source.slice(0,split));stream.write(source.slice(split));
    assert.equal(serialize(await stream.close()),expected,'split '+split);
  }
  const bytes=new HTMLInputStream();for(const character of source)bytes.write(character);
  assert.equal(serialize(await bytes.close()),expected);
});

test('Reentrant HTML writes parse synchronously before remaining source and retain the current insertion context',async()=>{
  const events=[],stream=new HTMLInputStream({onScript(node,_context,input){
    const label=text(node);events.push(label);
    assert.equal(find(input.document,'aside'),undefined,'Future source was parsed before the script returned');
    if(label==='outer'){
      input.write('<b>inserted</b><script>inner</script>');
      assert.equal(text(find(input.document,'em')),'nested');
      input.write('<span data-value="');input.write('a&gt;b">split');input.write('</span>');
    }else input.write('<em>nested</em>');
  }});
  stream.write('<!doctype html><main><script>outer</script><aside>remaining</aside></main>');
  assert.deepEqual(events,['outer','inner']);
  assert.equal(serialize(await stream.close()),serialize(parse('<!doctype html><main><script>outer</script><b>inserted</b><script>inner</script><em>nested</em><span data-value="a&gt;b">split</span><aside>remaining</aside></main>')));
});

test('Completed written text is visible before close without committing an unfinished entity or tag',async()=>{
  const stream=new HTMLInputStream();stream.write('<p>visible &am');assert.equal(text(find(stream.document,'p')),'visible ');
  stream.write('p; <b data-a="unfinished');assert.equal(text(find(stream.document,'p')),'visible & ');assert.equal(find(stream.document,'b'),undefined);
  stream.write('">bold');assert.equal(text(find(stream.document,'b')),'bold');await stream.close();
});

test('Pending external script work holds later source and EOF while additional writes keep insertion order',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),events=[];
  const stream=new HTMLInputStream({onScript(node,_context,input){events.push(text(node));if(text(node)==='external')return gate.then(()=>input.write('<b>loaded</b>'));}});
  stream.write('<main><script>external</script><aside>after</aside></main>');stream.write('<footer>last</footer>');
  const done=stream.close();assert.equal(find(stream.document,'aside'),undefined);assert.equal(find(stream.document,'footer'),undefined);
  release();await done;
  assert.deepEqual(events,['external']);
  assert.equal(serialize(stream.document),serialize(parse('<main><script>external</script><b>loaded</b><aside>after</aside></main><footer>last</footer>')));
});

test('A nested pending script preserves its own remaining source before its caller resumes',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const stream=new HTMLInputStream({onScript(node,_context,input){if(text(node)==='outer')input.write('<script>inner</script><i>inner tail</i>');else return gate;}});
  stream.write('<main><script>outer</script><b>outer tail</b></main>');const done=stream.close();
  assert.equal(find(stream.document,'i'),undefined);release();await done;
  assert.equal(serialize(stream.document),serialize(parse('<main><script>outer</script><script>inner</script><i>inner tail</i><b>outer tail</b></main>')));
});

test('Script boundaries expose template context and never evaluate authored source themselves',async()=>{
  const events=[],stream=new HTMLInputStream({onScript(node,context){events.push([text(node),context.inTemplate]);}});
  stream.write('<script>before</script><template><script>inert</script></template><script>after</script>');await stream.close();
  assert.deepEqual(events,[['before',false],['inert',true],['after',false]]);
  assert.equal(text(tree.getTemplateContent(find(stream.document,'template'))),'inert');
});

test('Callback failures settle the stream and writes cannot revive a failed or finished parser',async()=>{
  const failure=new Error('script failed'),stream=new HTMLInputStream({onScript(){throw failure;}}),rejected=assert.rejects(stream.done,error=>error===failure);
  assert.throws(()=>stream.write('<script>bad</script>'),error=>error===failure);await rejected;
  assert.throws(()=>stream.write('later'),error=>error===failure);
  const closed=new HTMLInputStream();closed.write('<p>done');await closed.close();assert.throws(()=>closed.write('later'),TypeError);
  let reject;const pending=new Promise((_resolve,fail)=>{reject=fail;}),blocked=new HTMLInputStream({onScript(){return pending;}});
  blocked.write('<script>pending</script>');const error=assert.rejects(blocked.close(),value=>value===failure);reject(failure);await error;
  for(const value of [null,undefined,false,0]){
    const stream=new HTMLInputStream({onScript(){throw value;}}),rejected=assert.rejects(stream.done,error=>error===value);
    assert.throws(()=>stream.write('<script>bad</script>'),error=>error===value);await rejected;
    assert.throws(()=>stream.write('later'),error=>error===value);
  }
});

test('Long streams retain completed text, script data and source locations while dropping old input buffers',async()=>{
  const prefix='x &amp; 🙂\r\n'.repeat(8000),source='<!doctype html><p>'+prefix+'</p><script>if(a > b){const text="<div>"}</script><footer>last</footer>';
  const events=[],stream=new HTMLInputStream({sourceCodeLocationInfo:true,onScript(node){events.push(text(node));}});
  for(let offset=0;offset<source.length;offset+=113)stream.write(source.slice(offset,offset+113));
  await stream.close();const expected=parse(source,{sourceCodeLocationInfo:true});
  assert.equal(serialize(stream.document),serialize(expected));
  for(const tag of ['p','script','footer'])assert.deepEqual(find(stream.document,tag).sourceCodeLocation,find(expected,tag).sourceCodeLocation);
  assert.deepEqual(events,['if(a > b){const text="<div>"}']);
});

test('Retiring HTML input cancels pending and reentrant parsing without allowing late script writes to revive it',async()=>{
  const controller=new AbortController(),reason=new Error('retired');let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const stream=new HTMLInputStream({signal:controller.signal,onScript(_node,_context,input){return gate.then(()=>input.write('<b>late</b>'));}});
  stream.write('<script>external</script><aside>old source</aside>');const rejected=assert.rejects(stream.close(),error=>error===reason);
  controller.abort(reason);await rejected;release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(find(stream.document,'aside'),undefined);assert.equal(find(stream.document,'b'),undefined);
  assert.throws(()=>stream.write('later'),error=>error===reason);
  assert.throws(()=>new HTMLInputStream({signal:controller.signal}),error=>error===reason);
  const nested=new AbortController(),input=new HTMLInputStream({signal:nested.signal,onScript(){nested.abort(reason);}}),failed=assert.rejects(input.done,error=>error===reason);
  input.write('<script>abort</script><footer>never parsed</footer>');await failed;assert.equal(find(input.document,'footer'),undefined);
});
