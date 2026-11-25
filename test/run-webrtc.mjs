import {run_browser_tests} from './dotnet-browser-tests.mjs';
for(const browser of ['firefox','chromium']){
  const status=run_browser_tests({trait:'WebRTC',browser});
  if(status){process.exitCode=status;break;}
}
