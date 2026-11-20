import {ServiceWorkerScripts} from '../service_worker/scripts.mjs';
let scripts;
export function configure_service_worker_scripts(profile){scripts=new ServiceWorkerScripts(profile.scripts,{restoring:!!profile.restoring});}
export function fetch_service_worker_script(url,options,type,fetch){return scripts?scripts.fetch(url,options,type,fetch):fetch(url,options);}
export function service_worker_script_snapshot(){return scripts?.snapshot()||[];}
export function remember_service_worker_script(script){if(scripts&&!scripts.entries.has(script.url))scripts.set(script);}
