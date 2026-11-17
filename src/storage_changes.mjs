// Apply an operation to the host's current state, rather than replacing it with
// a potentially stale snapshot from another document.
export function apply_storage_change(entries,change){
  const values=new Map(entries||[]);
  if(change?.type==='clear')values.clear();
  else if(change?.type==='set'&&typeof change.key==='string'&&typeof change.value==='string')values.set(change.key,change.value);
  else if(change?.type==='remove'&&typeof change.key==='string')values.delete(change.key);
  else throw new TypeError('Invalid storage mutation');
  return [...values];
}
