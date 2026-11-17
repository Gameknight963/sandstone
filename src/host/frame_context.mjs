import {same_site} from './request.mjs';

export function frame_cross_site(frame,frames) {
  const root=frames[frame.root_id]||frame,top=new URL(root.url);
  for(let current=frame;current;current=frames[current.parent_id]){
    if(current.broadcast_origin?.startsWith('opaque:'))return true;
    let url=new URL(current.url);
    if(url.origin==='null'&&current.origin&&current.origin!=='null')url=new URL(current.origin);
    if(!same_site(top,url))return true;
  }
  return false;
}
