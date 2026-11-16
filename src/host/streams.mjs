// Pull one chunk at a time across RPC, preserving backpressure for long-lived responses.
export const requests = new Map();
export function request_key(frame_id, request_id) { return `${frame_id}:${request_id}`; }
export function cancel_requests(frame_id) {
  for (const [key, request] of requests) {
    if (request.frame_id !== frame_id) continue;
    request.controller.abort();
    request.reader?.cancel().catch(() => {});
    requests.delete(key);
  }
}
