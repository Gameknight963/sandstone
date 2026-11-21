import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,mkdtempSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const directory=fileURLToPath(new URL('.',import.meta.url));
const lock=JSON.parse(readFileSync(join(directory,'source-lock.json'),'utf8'));
function run(command,args,cwd){
  if(command==='npm'&&process.platform==='win32'){
    const cli=process.env.npm_execpath||join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
    assert.ok(existsSync(cli),'Cannot locate the npm CLI');
    command=process.execPath;args=[cli,...args];
  }
  const result=spawnSync(command,args,{cwd,encoding:'utf8'});
  if(result.error)throw result.error;
  assert.equal(result.status,0,command+' failed: '+result.stderr);
  return result.stdout.trim();
}
export function pack(source){
  source=resolve(source);
  const client=join(source,'client');
  const repositories=[[source,lock.upstream],[join(client,'wisp_client'),lock.wisp],...lock.dependencies.map(dependency=>[join(client,'build',dependency.name),dependency])];
  for(const [path,repository] of repositories)assert.equal(run('git',['rev-parse','HEAD'],path),repository.commit,'Source revision differs: '+path);
  // Later patches can change an earlier patch's context. Validate the complete
  // stack in reverse order on disposable copies, preserving the build tree.
  const validation=mkdtempSync(join(tmpdir(),'sandstone-libcurl-patches-'));
  for(const patch of lock.patches){
    const text=readFileSync(join(directory,patch),'utf8');
    for(const match of text.matchAll(/^\+\+\+ b\/(.+)$/gm)){
      const filename=match[1].trim(),target=join(validation,filename);
      assert.ok(resolve(target).startsWith(resolve(validation)+'/')||resolve(target).startsWith(resolve(validation)+'\\'),'Patch path escapes validation directory');
      mkdirSync(dirname(target),{recursive:true});copyFileSync(join(source,filename),target);
    }
  }
  for(const patch of [...lock.patches].reverse())run('git',['apply','--reverse',join(directory,patch)],validation);
  const ca=readFileSync(join(client,'build/cacert.pem'));
  assert.equal(createHash('sha256').update(ca).digest('hex'),lock.caBundleSHA256);
  const manifest=JSON.parse(readFileSync(join(client,'package.json'),'utf8'));
  assert.equal(manifest.version,lock.version);
  const work=mkdtempSync(join(tmpdir(),'sandstone-libcurl-package-')),stage=join(work,'package');mkdirSync(stage);
  for(const filename of ['libcurl.js','libcurl.mjs','libcurl.wasm','libcurl_full.js','libcurl_full.mjs'])copyFileSync(join(client,'out',filename),join(stage,filename));
  for(const filename of ['LICENSE','README.md'])copyFileSync(join(source,filename),join(stage,filename));
  for(const filename of ['source-lock.json',...lock.patches,'SOURCE.txt','cacert.pem'])copyFileSync(join(directory,filename),join(stage,filename));
  const licenses=join(stage,'licenses');mkdirSync(licenses);
  copyFileSync(join(client,'wisp_client/LICENSE'),join(licenses,'wisp-client-LICENSE'));
  for(const dependency of lock.dependencies){
    const name=dependency.name,filename=['curl','nghttp2'].includes(name)?'COPYING':'LICENSE';
    copyFileSync(join(client,'build',name,filename),join(licenses,name+'-'+filename));
  }
  writeFileSync(join(stage,'package.json'),JSON.stringify(manifest,null,2)+'\n');
  const result=JSON.parse(run('npm',['pack',stage,'--ignore-scripts','--json','--pack-destination',work],work))[0];
  const archive=join(directory,lock.archive);copyFileSync(join(work,result.filename),archive);
  console.log('Built '+archive);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  assert.ok(process.argv[2],'Pass the patched upstream source directory');
  pack(process.argv[2]);
}
