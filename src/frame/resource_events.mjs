import * as loader from './loader.mjs';
import {native_dom} from './dom_operations.mjs';

// Initial resources are downloaded while their elements still belong to an
// inert document. Deliver events in a task after installation so preceding
// classic scripts and the element's rewritten event attributes are available.
export function schedule_resource_event(element,callback){
  let timer,observer;
  const cancel=()=>{clearTimeout(timer);observer?.disconnect();observer=null;};
  const deliver=()=>{
    if(!loader.is_loaded||!element.isConnected||native_dom.owner.call(element)!==document){
      observer??=new MutationObserver(()=>{cancel();timer=setTimeout(deliver,0);});
      observer.observe(document,{childList:true,subtree:true});
      return;
    }
    cancel();
    callback();
  };
  timer=setTimeout(deliver,0);
  return cancel;
}
