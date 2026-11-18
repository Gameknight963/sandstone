// MessagePorts preserve each sender's order, but same-origin frames can write
// one area synchronously through different ports. Commit their shared sequence.
export class StorageWriteOrder {
  constructor(){this.next=1;this.pending=new Map();}
  accept(sequence,commit){
    if(!Number.isSafeInteger(sequence)||sequence<this.next||sequence>this.next+10000||this.pending.has(sequence))throw new TypeError('Invalid storage write order');
    this.pending.set(sequence,commit);
    while(this.pending.has(this.next)){
      const apply=this.pending.get(this.next);this.pending.delete(this.next++);apply();
    }
  }
}
