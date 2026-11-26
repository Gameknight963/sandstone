// The same module can run from embedded bytes in a file:// page.
export async function loadCore(bytes) {
  const {instance}=await WebAssembly.instantiate(bytes,{
    wasi_snapshot_preview1:{proc_exit(code){throw new Error('WASM exit '+code);}},
    env:{emscripten_notify_memory_growth(){}}
  });
  const wasm=instance.exports;wasm._initialize?.();
  const decoder=new TextDecoder('utf-16le',{fatal:true,ignoreBOM:true});
  function text(pointer,length){
    if(length>=128){try{return decoder.decode(new Uint8Array(wasm.memory.buffer,pointer,length*2));}catch{}}
    const units=new Uint16Array(wasm.memory.buffer,pointer,length);let value='';
    for(let i=0;i<length;i+=8192)value+=String.fromCharCode(...units.subarray(i,Math.min(i+8192,length)));
    return value;
  }
  function write(source,edits=[]){
    const strings=edits.map(edit=>String(edit[2]));
    const size=source.length+strings.reduce((sum,value)=>sum+value.length,0);
    const pointer=wasm.reserve_input(size),metadata=wasm.reserve_edits(edits.length);
    const units=new Uint16Array(wasm.memory.buffer,pointer,size),view=new DataView(wasm.memory.buffer);
    for(let i=0;i<source.length;i++)units[i]=source.charCodeAt(i);
    let offset=source.length;
    for(let i=0;i<edits.length;i++){
      const at=metadata+i*24,value=strings[i],edit=edits[i];
      view.setUint32(at,edit[0],true);view.setUint32(at+4,edit[1],true);
      view.setUint32(at+8,offset,true);view.setUint32(at+12,value.length,true);
      view.setFloat64(at+16,Number(edit[3])||0,true);
      for(let j=0;j<value.length;j++)units[offset++]=value.charCodeAt(j);
    }
  }
  function result(pointer){const h=new Uint32Array(wasm.memory.buffer,pointer,10);return text(h[6],h[7]);}
  function unpackParts(pointer){
    const h=new Uint32Array(wasm.memory.buffer,pointer,10);
    const strings=text(h[2],h[3]),rows=new Uint32Array(wasm.memory.buffer,h[0],h[1]*2),output=[];
    for(let i=0;i<rows.length;i+=2)output.push(strings.slice(rows[i],rows[i]+rows[i+1]));
    return output;
  }
  function writeMarkers(source,markers){
    const strings=[];for(const [key,value]of markers)strings.push([0,0,key],[0,0,value]);write(source,strings);
  }
  return {
    srcset(input){
      const source=String(input);write(source);
      const h=new Uint32Array(wasm.memory.buffer,wasm.scan_srcset(source.length),10);
      const strings=text(h[2],h[3]),rows=new Uint32Array(wasm.memory.buffer,h[0],h[1]*4),output=[];
      for(let i=0;i<rows.length;i+=4)output.push({start:rows[i],end:rows[i+1],url:strings.slice(rows[i+2],rows[i+2]+rows[i+3])});
      return output;
    },
    render(source,edits,begin=0,end=source.length){
      write(source,edits);return result(wasm.render_source(source.length,edits.length,begin,end));
    },
    editParts(parts,edits){
      const source=parts.join(''),tuples=edits.map(({start,end,value})=>[start,end,value]);
      const pointer=wasm.reserve_parts(parts.length);
      // write() can grow memory, so acquire the parts view afterwards.
      write(source,tuples);
      const sizes=new Uint32Array(wasm.memory.buffer,pointer,parts.length);
      for(let i=0;i<parts.length;i++)sizes[i]=parts[i].length;
      return unpackParts(wasm.edit_css_nodes(parts.length,edits.length));
    },
    restore(source,markers,transform,prefixes=false){
      writeMarkers(source,markers);
      const h=new Uint32Array(wasm.memory.buffer,wasm.restore_stylesheet(source.length,markers.size,+prefixes,+!!transform),10);
      if(transform){
        const arena=text(h[2],h[3]),rows=new Uint32Array(wasm.memory.buffer,h[4],h[5]*4),edits=[];
        for(let i=0;i<rows.length;i+=4)edits.push({start:rows[i],end:rows[i+1],value:arena.slice(rows[i+2],rows[i+2]+rows[i+3])});
        return transform(edits);
      }
      return h[5]?text(h[6],h[7]):source;
    },
    restoreParts(parts,markers,prefixes=false){
      const pointer=wasm.reserve_parts(parts.length);
      writeMarkers(parts.join(''),markers);
      const sizes=new Uint32Array(wasm.memory.buffer,pointer,parts.length);
      for(let i=0;i<parts.length;i++)sizes[i]=parts[i].length;
      return unpackParts(wasm.restore_css_nodes(parts.reduce((sum,part)=>sum+part.length,0),markers.size,+prefixes,parts.length));
    }
  };
}
