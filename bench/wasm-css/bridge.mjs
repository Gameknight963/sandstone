// The timed methods include copying the input and materializing normal JS
// strings, objects, arrays and Maps. No UTF-8 conversion changes JS offsets.
export async function loadWasm(bytes) {
  const {instance} = await WebAssembly.instantiate(bytes, {
    wasi_snapshot_preview1: {proc_exit(code) { throw new Error('WASM exit '+code); }},
    env: {emscripten_notify_memory_growth() {}}
  });
  const wasm = instance.exports;
  wasm._initialize?.();
  const decoder=new TextDecoder('utf-16le',{fatal:true,ignoreBOM:true});
  function write(source, prefix='') {
    const pointer = wasm.reserve_input(source.length+prefix.length);
    const target = new Uint16Array(wasm.memory.buffer, pointer, source.length+prefix.length);
    for(let i=0;i<source.length;i++) target[i]=source.charCodeAt(i);
    for(let i=0;i<prefix.length;i++) target[source.length+i]=prefix.charCodeAt(i);
  }
  function text(pointer,length) {
    // Native decoding avoids a slow spread/call per chunk for large outputs.
    // A fatal decoder plus the code-unit fallback preserves lone surrogates;
    // ignoreBOM keeps a leading U+FEFF rather than silently removing it.
    if(length>=128){try{return decoder.decode(new Uint8Array(wasm.memory.buffer,pointer,length*2));}catch{}}
    const units=new Uint16Array(wasm.memory.buffer,pointer,length);
    let result='';
    for(let i=0;i<length;i+=8192)result+=String.fromCharCode(...units.subarray(i,Math.min(i+8192,length)));
    return result;
  }
  function unpack(pointer,kind,source) {
    const h=new Uint32Array(wasm.memory.buffer,pointer,10);
    // Decode the arena once, then slice it. Crossing the boundary separately
    // for every URL, marker and edit was more expensive than the C++ work.
    const strings=text(h[2],h[3]);
    const value=(offset,length)=>strings.slice(offset,offset+length);
    if(kind==='scan'){
      const rows=new Uint32Array(wasm.memory.buffer,h[0],h[1]*11), refs=[];
      for(let i=0;i<rows.length;i+=11){
        const flags=rows[i+4],ending=flags>>3&7;
        const ref={start:rows[i],end:rows[i+1],url:value(rows[i+2],rows[i+3]),imported:!!(flags&1),quoted:!!(flags&2)};
        if(flags&4)ref.font=true;
        if(ending){ref.ending=['','quote','parenthesis','string','unquoted'][ending];if(!(flags&2))ref.trailing=value(rows[i+9],rows[i+10]);}
        if(flags&64){ref.condition=value(rows[i+7],rows[i+8]);ref.condition_start=rows[i+5];ref.condition_end=rows[i+6];}
        refs.push(ref);
      }
      return refs;
    }
    const edits=[], markers=new Map();
    const rows=new Uint32Array(wasm.memory.buffer,h[4],h[5]*4);
    for(let i=0;i<rows.length;i+=4)edits.push({start:rows[i],end:rows[i+1],value:value(rows[i+2],rows[i+3])});
    const pairs=new Uint32Array(wasm.memory.buffer,h[8],h[9]*4);
    for(let i=0;i<pairs.length;i+=4)markers.set(value(pairs[i],pairs[i+1]),value(pairs[i+2],pairs[i+3]));
    return {css:h[5]?text(h[6],h[7]):source,markers,edits};
  }
  return {
    scan(source){write(source);return unpack(wasm.scan_css(source.length),'scan');},
    prepare(source,prefix){write(source,prefix);return unpack(wasm.prepare_css(source.length,prefix.length),'prepare',source);},
    // Diagnostic only: input already resident, no returned JS strings/objects.
    residentScan(source){write(source);return ()=>wasm.scan_css(source.length);},
    residentPrepare(source,prefix){write(source,prefix);return ()=>wasm.prepare_css(source.length,prefix.length);},
  };
}
