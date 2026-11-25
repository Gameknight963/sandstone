import {run_browser_tests} from './dotnet-browser-tests.mjs';
const args=new Set(process.argv.slice(2));
for(const arg of args)if(!['--native','--public','--watch-only','--chromium'].includes(arg))throw new Error('Unknown YouTube option: '+arg);
process.exitCode=run_browser_tests({testClass:'YouTubeTests',live:true,browser:args.has('--chromium')?'chromium':process.env.BROWSER||'firefox',env:{
  ...(args.has('--native')?{YOUTUBE_NATIVE:'1'}:{}),...(args.has('--public')?{YOUTUBE_PUBLIC:'1'}:{}),...(args.has('--watch-only')?{YOUTUBE_WATCH_ONLY:'1'}:{})
}});
