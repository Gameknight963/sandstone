// A document's beacons and keepalive fetches share the same body-byte allowance.
export const keepalive_budget = {queued:0};
export function reserve_keepalive(size) {
  if (keepalive_budget.queued + size > 65536) throw new TypeError('Keepalive request quota exceeded');
  keepalive_budget.queued += size;
  let released = false;
  return () => { if (!released) { released = true; keepalive_budget.queued -= size; } };
}
