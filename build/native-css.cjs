const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),manifestPath=path.join(root,'vendor/native/css.manifest.json');
const sources=['native/css/css.cpp','native/css/core.cpp','native/css/exports.json','native/css/build.sh'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const snapshot=()=>({abi:1,binary:hash(fs.readFileSync(path.join(root,'vendor/native/css.wasm'))),
  sources:Object.fromEntries(sources.map(name=>[name,hash(fs.readFileSync(path.join(root,name),'utf8').replace(/\r\n/g,'\n'))]))});
function verify(){
  try{
    const saved=JSON.parse(fs.readFileSync(manifestPath,'utf8')),current=snapshot();
    if(saved.abi!==current.abi||saved.binary!==current.binary||JSON.stringify(saved.sources)!==JSON.stringify(current.sources))throw new Error('Source/binary mismatch');
  }catch(error){throw new Error('Native CSS binary is missing or stale. Rebuild with an activated Emscripten SDK: bash native/css/build.sh',{cause:error});}
}
module.exports=verify;
if(require.main===module){
  if(process.argv.includes('--write'))fs.writeFileSync(manifestPath,JSON.stringify({...snapshot(),compiler:process.env.NATIVE_CSS_COMPILER_VERSION||'Emscripten'},null,2)+'\n');
  else verify();
}
