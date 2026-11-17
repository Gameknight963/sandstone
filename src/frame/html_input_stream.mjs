import {Parser} from 'parse5';

// Parser input for document.open/write/close. Keep unconsumed source outside
// the tokenizer at script boundaries: a reentrant write must parse its own
// input synchronously without consuming the caller's remaining HTML.
export class HTMLInputStream {
  #parser;#root;#script;#update;#writer;#pending;#depth=0;#blocks=0;#insertions=[];#remaining=[];
  #signal;#abort;
  #closing=false;#ended=false;#failed=false;#error;#resolve;#reject;
  constructor({onScript,onUpdate,context,signal,...options}={}){
    if(onScript!==undefined&&typeof onScript!=='function')throw new TypeError('onScript must be a function');
    if(onUpdate!==undefined&&typeof onUpdate!=='function')throw new TypeError('onUpdate must be a function');
    signal?.throwIfAborted();
    this.done=new Promise((resolve,reject)=>{this.#resolve=resolve;this.#reject=reject;});
    this.#script=onScript;this.#update=onUpdate;
    const stream=this;
    // The script's writer retains its insertion point across asynchronous
    // loading. Ordinary source writes append after already-buffered HTML.
    this.#writer={write(text){stream.#write(text,true);},get document(){return stream.document;}};
    const script=node=>{
      if(!this.#script)return;
      this.#pending={node,inTemplate:this.#parser.openElements.tmplCount>0};
      this.#parser.tokenizer.pause();
    };
    if(context!==undefined){this.#parser=Parser.getFragmentParser(context,options);this.#parser.scriptHandler=script;this.#root=this.#parser.treeAdapter.getFirstChild(this.#parser.document);}
    else{this.#parser=new Parser(options,undefined,null,script);this.#root=this.#parser.document;}
    if(signal){this.#signal=signal;this.#abort=()=>this.#fail(signal.reason);signal.addEventListener('abort',this.#abort,{once:true});}
  }
  get document(){return this.#root;}
  write(text){this.#write(text,false);}
  #write(text,insert){
    if(this.#failed)throw this.#error;
    if(this.#ended)throw new TypeError('The HTML input stream is closed');
    if(typeof text!=='string')throw new TypeError('HTML input must be a string');
    if(this.#blocks)(insert?this.#insertions:this.#remaining).push(text);
    else this.#parse(text);
  }
  close(){this.#closing=true;this.#finish();return this.done;}
  #fail(error){
    if(this.#failed||this.#ended)return;
    this.#failed=true;this.#error=error;this.#insertions.length=this.#remaining.length=0;this.#detach();this.#reject(error);
  }
  #detach(){this.#signal?.removeEventListener('abort',this.#abort);}
  #parse(text){
    this.#depth++;
    try{
      let offset=0;
      while(offset<text.length){
        // A completed script end tag ends at '>'. Smaller boundaries inside
        // attributes, comments or raw text are harmless tokenizer hibernations.
        const delimiter=text.indexOf('>',offset),end=delimiter<0?text.length:delimiter+1;
        this.#parser.tokenizer.write(text.slice(offset,end),false);offset=end;
        if(this.#pending){
          const script=this.#pending;this.#pending=undefined;
          // The end-tag handler has now popped the script element. Resume with
          // no unread input before allowing synchronous nested writes.
          this.#parser.tokenizer.resume();
          const result=this.#script(script.node,{inTemplate:script.inTemplate},this.#writer);
          if(result&&typeof result.then==='function'){
            this.#blocks++;
            Promise.resolve(result).then(()=>{this.#blocks--;if(!this.#blocks)this.#drain();},error=>this.#fail(error));
          }
        }
        if(this.#failed)break;
        if(this.#blocks){if(offset<text.length)this.#remaining.push(text.slice(offset));break;}
      }
      // Expose completed text immediately, while retaining partial entities,
      // tags, comments and script data in the tokenizer across write calls.
      if(!this.#failed){this.#parser.tokenizer.flushCharacters();this.#update?.(this.document);}
    }catch(error){this.#fail(error);throw error;}
    finally{this.#depth--;this.#finish();}
  }
  #drain(){
    if(this.#failed||this.#ended)return;
    const pending=[...this.#insertions,...this.#remaining];this.#insertions=[];this.#remaining=[];
    try{
      // Keep EOF pending until every saved source frame has been consumed.
      this.#depth++;
      for(let index=0;index<pending.length;index++){
        if(this.#failed)break;
        this.#parse(pending[index]);
        if(this.#blocks){this.#remaining.push(...pending.slice(index+1));break;}
      }
    }catch(error){this.#fail(error);}
    finally{this.#depth--;this.#finish();}
  }
  #finish(){
    if(!this.#closing||this.#ended||this.#failed||this.#blocks||this.#depth)return;
    try{this.#parser.tokenizer.write('',true);this.#update?.(this.document);this.#ended=true;this.#detach();this.#resolve(this.document);}
    catch(error){this.#fail(error);}
  }
}
