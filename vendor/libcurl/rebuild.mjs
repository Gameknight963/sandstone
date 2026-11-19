import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,mkdtempSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {pack} from './pack.mjs';

const directory=fileURLToPath(new URL('.',import.meta.url));
const lock=JSON.parse(readFileSync(join(directory,'source-lock.json'),'utf8'));
assert.equal(process.platform,'linux','Rebuild using Linux or WSL');
const jobs=process.env.SANDSTONE_BUILD_JOBS||'2';
assert.match(jobs,/^[1-9][0-9]?$/);
const work=process.argv[2]?resolve(process.argv[2]):mkdtempSync(join(tmpdir(),'sandstone-libcurl-'));
assert.ok(!/\s/.test(work),'The upstream build needs a path without whitespace');
const environment={...process.env,OUT_DIR:'out',DESTDIR:'',EMCC_CORES:jobs};
function run(command,args,cwd=work,capture=false){
  const result=spawnSync(command,args,{cwd,env:environment,encoding:'utf8',stdio:capture?'pipe':'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(command+' failed ('+result.status+')'+(capture?'\n'+result.stderr:''));
  return result.stdout;
}
mkdirSync(work,{recursive:true});
assert.ok(run('emcc',['--version'],work,true).includes(lock.emscripten),'Activate the locked Emscripten version first');
const ca=readFileSync(join(directory,'cacert.pem'));
assert.equal(createHash('sha256').update(ca).digest('hex'),lock.caBundleSHA256,'CA bundle differs from the source lock');
function clone(repository,path){
  assert.match(repository.commit,/^[0-9a-f]{40}$/);
  mkdirSync(path,{recursive:true});
  run('git',['init',path]);run('git',['remote','add','origin',repository.url],path);
  run('git',['fetch','--depth=1','origin',repository.commit],path);
  run('git',['checkout','--detach','FETCH_HEAD'],path);
}
const source=join(work,'source'),client=join(source,'client');
clone(lock.upstream,source);clone(lock.wisp,join(client,'wisp_client'));
run('git',['apply',join(directory,'empty-headers.patch')],source);
const manifest=JSON.parse(readFileSync(join(client,'package.json'),'utf8'));
manifest.version=lock.version;writeFileSync(join(client,'package.json'),JSON.stringify(manifest,null,2)+'\n');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
for(const dependency of lock.dependencies){
  assert.match(dependency.name,/^[a-z0-9]+$/);
  assert.match(dependency.commit,/^[0-9a-f]{40}$/);
  const path=join(client,'tools',dependency.name+'.sh');
  let script=readFileSync(path,'utf8');
  const matches=[...script.matchAll(/^git clone .+$/gm)];assert.equal(matches.length,1);
  const name=quote(dependency.name);
  const commands=[`git init ${name}`,`git -C ${name} remote add origin ${quote(dependency.url)}`,`git -C ${name} fetch --depth=1 origin ${dependency.commit}`,`git -C ${name} checkout --detach FETCH_HEAD`];
  if(dependency.recursive)commands.push(`git -C ${name} submodule update --init --recursive --depth=1`);
  script=script.replace(matches[0][0],commands.join('\n')).replace('CORE_COUNT=$(nproc --all)','CORE_COUNT='+jobs);
  writeFileSync(path,script);
}
mkdirSync(join(client,'build'),{recursive:true});copyFileSync(join(directory,'cacert.pem'),join(client,'build/cacert.pem'));
const certificateScript=join(client,'tools/generate_cert.sh');
const download='wget "https://curl.se/ca/cacert.pem" -O "$CACERT_FILE"';
const script=readFileSync(certificateScript,'utf8');assert.ok(script.includes(download));
writeFileSync(certificateScript,script.replace(download,'test -f "$CACERT_FILE"'));
run('bash',['build.sh','all'],client);
pack(source);
