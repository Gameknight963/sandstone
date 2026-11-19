// Keep trusted compiler evaluation in its own webpack module. Other runtime
// modules can still be concatenated/minified, and the compiler inherits the
// frame bundle's captured native built-ins instead of authored replacements.
module.exports=function load_worker_bundler(source){
  return eval(source+'\n;sandstone_worker_bundler;\n//# sourceURL=sandstone-worker-compiler\n');
};
