import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
let pending;
export function test_font(){
  return pending??=(async()=>{
    const options={cwd:root,windowsHide:true,encoding:'buffer',maxBuffer:1024*1024};
    try{
      await execute('dotnet',['build','test/Sandstone.TestFixtures','--nologo','--verbosity','quiet'],options);
      const {stdout}=await execute('dotnet',['test/Sandstone.TestFixtures/bin/Debug/net10.0/Sandstone.TestFixtures.dll','--font'],options);
      return stdout;
    }catch(error){
      throw new Error('Could not generate the in-memory test font (.NET 10 SDK required).\n'+(error.stdout?.toString()||'')+(error.stderr?.toString()||''),{cause:error});
    }
  })();
}
