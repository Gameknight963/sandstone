import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';

const cases=[
  ['template initializer',"let text=`before`\nthis.value=text\nreturn this.value"],
  ['object initializer',"const options={value:7}\nthis.value=options.value\nreturn this.value"],
  ['arrow initializer',"const read=()=>7\nthis.value=read()\nreturn this.value"],
  ['expression statements',"this.value=1\nthis.value+=2\nreturn this.value"],
  ['call statements',"this.accept=()=>{this.value=7}\nthis.accept()\nthis.value++\nreturn this.value"],
  ['return expression',"return {saved:true}\nthis.unreachable=true"],
  ['throw expression',"try{throw new Error('expected')\nthis.unreachable=true}catch(error){return error.message}"],
  ['if and else bodies',"if(false)this.value=1\nelse this.value=2\nreturn this.value"],
  ['for declaration headers',"this.value=0;for(let index=0;index<3;index++)this.value+=index\nreturn this.value"],
  ['for of headers',"this.value=0;for(const value of [1,2,3])this.value+=value\nreturn this.value"],
  ['for in headers',"this.value=0;for(const key in {a:1,b:2})this.value++\nreturn this.value"],
  ['do while terminators',"this.value=0;do{this.value++}while(false)\nthis.value++\nreturn this.value"],
  ['constructor receiver precedence',"this.Widget=class{value=7};return new this.Widget().value"],
  ['class fields and static blocks',"class Box{#count=0\nvalue=null\nstatic{const label=`ready`\nthis.label=label}\nbump(){this.#count++\nthis.value=this.#count}}const box=new Box;box.bump();return [box.value,Box.label]"],
  ['directive prologues',"'use strict'\nconst state={saved:true}\nthis.value=state.saved\nreturn this.value"],
  ['Annex B function bodies',"if(true)function helper(){return 7}\nelse this.value=0\nreturn helper()"],
  ['line comments',"let text='saved' // initializer\nthis.value=text // assignment\nreturn this.value"]
];
for(const [name,body] of cases)test('Rewriting preserves ASI for '+name,()=>{
  const source='(function(){'+body+'}).call({})',rewritten=rewrite_source(source,[]);
  const run=script=>new Script(script).runInNewContext({__get_this__:value=>value});
  assert.equal(JSON.stringify(run(rewritten)),JSON.stringify(run(source)));
});

test('Rewriting preserves use asm bodies and module default expression boundaries',()=>{
  const asm="function fast(){'use asm'\nreturn 1}",output=rewrite_source(asm,[]);
  assert.equal(output,asm);
  const source='export default {saved:true}\nthis.value=1',rewritten=rewrite_source(source,[],{module:true});
  assert.doesNotThrow(()=>rewrite_source(rewritten,[],{module:true}));
  assert.match(rewritten,/export default \{saved:true\};/);
});
