import {run_browser_tests} from './dotnet-browser-tests.mjs';
const selected=process.argv.slice(2);
process.exitCode=run_browser_tests({testClass:'LiveSiteTests',live:true,env:selected.length?{LIVE_SITES:selected.join(',')}:undefined});
