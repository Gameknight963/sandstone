import {apply_storage_change} from './storage_changes.mjs';

// Retain optimistic local writes until the host acknowledges them. A peer's
// earlier update must not roll back a newer write still waiting to be committed.
export class StorageReplica {
  constructor(entries=[],{replace,submit}){
    this.confirmed=entries||[];this.pending=[];this.sequence=0;
    Object.assign(this,{replace,submit});
  }
  write(change){
    const operation={...change,id:++this.sequence};
    this.pending.push(operation);this.submit(operation);
  }
  update(change,ack){
    this.confirmed=apply_storage_change(this.confirmed,change);
    if(ack!==undefined)this.pending=this.pending.filter(operation=>operation.id!==ack);
    this.refresh();
  }
  reset(entries){this.confirmed=entries||[];this.refresh();}
  refresh(){
    let entries=this.confirmed;
    for(const operation of this.pending)entries=apply_storage_change(entries,operation);
    this.replace(entries);
  }
}
