import {createServer} from 'node:http';

// libcurl may offer h2c on ordinary HTTP requests. Decline unsupported protocol
// upgrades through Node's normal HTTP path instead of handing them to Wisp.
export function create_relay_server(listener) {
  return createServer({
    shouldUpgradeCallback: request => request.headers.upgrade?.toLowerCase() === 'websocket'
  }, listener);
}
