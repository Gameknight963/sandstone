import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const build=spawnSync('dotnet',['build','test/Sandstone.BrowserTests'],{cwd:root,stdio:'inherit',windowsHide:true});
if(build.error)throw build.error;if(build.status)process.exit(build.status);
// Use the driver belonging to the locked .NET package, even when npm's
// Playwright version differs. No additional PowerShell installation is needed.
const cli=fileURLToPath(new URL('./Sandstone.BrowserTests/bin/Debug/net10.0/.playwright/package/cli.js',import.meta.url));
const args=process.argv.slice(2);
const result=spawnSync(process.execPath,[cli,'install',...(args.length?args:['--only-shell','chromium','firefox'])],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;process.exitCode=result.status??1;
