import * as loader from '../loader.mjs';
import {listen_runtime} from '../runtime_events.mjs';

const window=globalThis,document=window.document,focus=window.focus;
const has_focus=window.Document?.prototype.hasFocus,apply=Reflect.apply;
if(document&&focus&&has_focus)listen_runtime(window,'pointerdown',event=>{
  // A virtual top-level page is physically an iframe. Apps that cancel mouse
  // defaults (canvas editors and games) still expect its keyboard shortcuts to
  // work after a real click. Preserve native behavior for nested frames.
  if(loader.is_iframe||!event.isTrusted||apply(has_focus,document,[]))return;
  apply(focus,window,[]);
},true);
