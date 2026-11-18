import {apply_storage_change} from './storage_changes.mjs';

// Retain optimistic local writes until the host acknowledges them. A peer's
// earlier update must not roll back a newer write still waiting to be committed.
export class StorageReplica {
  constructor(entries=[],{replace,submit}){
    this.confirmed=entries||[];this.pending=[];this.sequence=0;this.revision=-1;
    Object.assign(this,{replace,submit});
  }
  write(change,submit=this.submit){
    const operation={...change,id:++this.sequence};
    this.pending.push(operation);this.refresh();submit(operation);
  }
  update(change,ack,revision){
    // Shared views can receive the same commit through several frame ports.
    // Older deliveries still acknowledge writes, but cannot roll back the area.
    if(revision===undefined||revision>this.revision){
      this.confirmed=apply_storage_change(this.confirmed,change);
      if(revision!==undefined)this.revision=revision;
    }
    this.pending=this.pending.filter(operation=>!(operation.id===(ack??change.id)&&operation.context===change.context));
    this.refresh();
  }
  reset(entries,revision){
    if(revision!==undefined&&revision<this.revision)return;
    this.confirmed=entries||[];if(revision!==undefined)this.revision=revision;this.refresh();
  }
  refresh(){
    let entries=this.confirmed;
    for(const operation of this.pending)entries=apply_storage_change(entries,operation);
    this.replace(entries);
  }
}
