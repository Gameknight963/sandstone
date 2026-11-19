import source from '../../dist/sandstone_worker_bundler.js';
import load_worker_bundler from './worker_bundler_loader.cjs';
import {compile_worker_cycles as compile} from './worker_module_cycles.mjs';

let bundler;
export function compile_worker_cycles(entry,records,loader){
  bundler??=load_worker_bundler(source);
  return compile(entry,records,loader,bundler.rollup);
}
