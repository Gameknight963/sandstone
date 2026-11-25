// Compatibility entry points only. xUnit owns test discovery, lifecycle,
// assertions and results; these launchers preserve the existing npm switches.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function run_browser_tests({testClass,trait,live=false,browser,env={}}={}){
  const command=['test','--project','test/Sandstone.BrowserTests','--output','Detailed'];
  if(testClass)command.push('--filter-class','Sandstone.BrowserTests.'+testClass);
  if(trait)command.push('--filter-trait','Category='+trait);
  const settings={...process.env,...env};
  if(live){settings.SANDSTONE_LIVE='1';command.push('--show-live-output','on');}
  if(browser)settings.BROWSER=browser;
  else if(settings.LIVE_BROWSER)settings.BROWSER=settings.LIVE_BROWSER;
  const result=spawnSync('dotnet',command,{cwd:root,env:settings,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  return result.status??1;
}
