// Workers inherit their creator's agent cluster. Walk only live worker edges
// to find the renderer which can receive their SharedArrayBuffers.
export function worker_renderer(frames,id){
  let frame=frames[id];const seen=new Set();
  if(!frame?.worker)return;
  while(frame.worker){
    if(seen.has(frame.id))return;seen.add(frame.id);
    const parent=frames[frame.parent_id];
    if(!parent||frame.parent_context!==parent.document_context||frame.root_id!==parent.root_id)return;
    frame=parent;
  }
  return frame;
}
