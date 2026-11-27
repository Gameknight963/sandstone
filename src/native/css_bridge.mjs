// UTF-16 preserves JS offsets, BOMs and lone surrogates without URL re-encoding.
export async function create_css_bridge(bytes) {
  let wasm, supports, callback_error;
  const decoder=new TextDecoder('utf-16le',{fatal:true,ignoreBOM:true});
  function text(pointer,length){
    if(length>=128){try{return decoder.decode(new Uint8Array(wasm.memory.buffer,pointer,length*2));}catch{}}
    const units=new Uint16Array(wasm.memory.buffer,pointer,length);let value='';
    for(let i=0;i<length;i+=8192)value+=String.fromCharCode(...units.subarray(i,Math.min(i+8192,length)));
    return value;
  }
  const {instance}=await WebAssembly.instantiate(bytes,{
    wasi_snapshot_preview1:{proc_exit(code){throw new Error('Native CSS exit '+code);}},
    env:{emscripten_notify_memory_growth(){},css_supports(pointer,length){
      try{return +!!supports(text(pointer,length));}catch(error){callback_error={error};throw error;}
    }}
  });
  wasm=instance.exports;wasm._initialize?.();
  function write(source,strings=[],supported=[]){
    const size=source.length+strings.reduce((sum,value)=>sum+value.length,0);
    const pointer=wasm.reserve_input(size),metadata=wasm.reserve_edits(strings.length);
    const units=new Uint16Array(wasm.memory.buffer,pointer,size),view=new DataView(wasm.memory.buffer);
    for(let i=0;i<source.length;i++)units[i]=source.charCodeAt(i);
    let offset=source.length;
    for(let i=0;i<strings.length;i++){
      const at=metadata+i*24,value=strings[i];
      view.setUint32(at,0,true);view.setUint32(at+4,0,true);
      view.setUint32(at+8,offset,true);view.setUint32(at+12,value.length,true);view.setFloat64(at+16,+!!supported[i],true);
      for(let j=0;j<value.length;j++)units[offset++]=value.charCodeAt(j);
    }
  }
  function unpack(pointer,source,want_edits=true,want_markers=false){
    const h=new Uint32Array(wasm.memory.buffer,pointer,10),strings=want_edits||want_markers?text(h[2],h[3]):'';
    const rows=new Uint32Array(wasm.memory.buffer,h[4],h[5]*4),edits=[],markers=new Map();
    if(want_edits)for(let i=0;i<rows.length;i+=4)edits.push({start:rows[i],end:rows[i+1],value:strings.slice(rows[i+2],rows[i+2]+rows[i+3])});
    const pairs=new Uint32Array(wasm.memory.buffer,h[8],h[9]*4);
    if(want_markers)for(let i=0;i<pairs.length;i+=4)markers.set(strings.slice(pairs[i],pairs[i]+pairs[i+1]),strings.slice(pairs[i+2],pairs[i+2]+pairs[i+3]));
    return {css:h[5]?text(h[6],h[7]):source,markers,edits};
  }
  function write_markers(source,markers){
    const strings=[];for(const [key,value]of markers)strings.push(key,value);write(source,strings);
  }
  return {
    memory_bytes:()=>wasm.memory.buffer.byteLength,
    callback_error:()=>callback_error,
    scan(source){
      write(source);const h=new Uint32Array(wasm.memory.buffer,wasm.scan_css(source.length),10);
      const strings=text(h[2],h[3]),rows=new Uint32Array(wasm.memory.buffer,h[0],h[1]*11),refs=[];
      const value=(offset,length)=>strings.slice(offset,offset+length);
      for(let i=0;i<rows.length;i+=11){
        const flags=rows[i+4],ending=flags>>3&7;
        const ref={start:rows[i],end:rows[i+1],url:value(rows[i+2],rows[i+3]),imported:!!(flags&1),quoted:!!(flags&2)};
        if(flags&4)ref.font=true;
        if(ending){ref.ending=['','quote','parenthesis','string','unquoted'][ending];if(!(flags&2))ref.trailing=value(rows[i+9],rows[i+10]);}
        if(flags&64){ref.condition=value(rows[i+7],rows[i+8]);ref.condition_start=rows[i+5];ref.condition_end=rows[i+6];}
        refs.push(ref);
      }
      return refs;
    },
    prepare(source,prefix,predicate){
      supports=predicate;callback_error=null;write(source,[prefix]);
      try{return unpack(wasm.prepare_css(source.length,prefix.length,+!!predicate),source,true,true);}finally{supports=null;}
    },
    restore(source,markers,edits_only){
      write_markers(source,markers);
      return unpack(wasm.restore_stylesheet(source.length,markers.size,0,+edits_only),source,edits_only);
    },
    restoreWithPrefixes(source,markers,edits_only,prefixes){
      write_markers(source,markers);
      return unpack(wasm.restore_stylesheet(source.length,markers.size,+prefixes,+edits_only),source,edits_only);
    },
    restoreParts(parts,markers,prefixes){
      const pointer=wasm.reserve_parts(parts.length),source=parts.join('');write_markers(source,markers);
      const sizes=new Uint32Array(wasm.memory.buffer,pointer,parts.length);
      for(let i=0;i<parts.length;i++)sizes[i]=parts[i].length;
      const h=new Uint32Array(wasm.memory.buffer,wasm.restore_css_nodes(source.length,markers.size,+prefixes,parts.length),10);
      const strings=text(h[2],h[3]),rows=new Uint32Array(wasm.memory.buffer,h[0],h[1]*2),output=[];
      for(let i=0;i<rows.length;i+=2)output.push(strings.slice(rows[i],rows[i]+rows[i+1]));
      return output;
    },
    apply(source,values,supported){
      write(source,values,supported);const pointer=wasm.apply_css_values(source.length,values.length);
      if(!pointer)return null;
      const h=new Uint32Array(wasm.memory.buffer,pointer,10);return {css:text(h[6],h[7])};
    },
    srcset(source){
      write(source);const h=new Uint32Array(wasm.memory.buffer,wasm.scan_srcset(source.length),10);
      const strings=text(h[2],h[3]),rows=new Uint32Array(wasm.memory.buffer,h[0],h[1]*4),output=[];
      for(let i=0;i<rows.length;i+=4)output.push({start:rows[i],end:rows[i+1],url:strings.slice(rows[i+2],rows[i+2]+rows[i+3])});
      return output;
    },
    applySrcset(source,values){
      write(source,values);const pointer=wasm.apply_srcset_urls(source.length,values.length);
      if(!pointer)return null;const h=new Uint32Array(wasm.memory.buffer,pointer,10);return {value:text(h[6],h[7])};
    }
  };
}
