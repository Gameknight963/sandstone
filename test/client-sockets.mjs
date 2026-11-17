import {channel} from 'node:diagnostics_channel';

// Closing a browser ends its Wisp connection, but remote TCP handshakes and
// half-closed peers can outlive it. Own those sockets for the test's lifetime.
export function track_client_sockets(){
  const sockets=new Set(),connections=channel('net.client.socket');
  const track=({socket})=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};
  connections.subscribe(track);
  return ()=>{connections.unsubscribe(track);for(const socket of sockets)socket.destroy();sockets.clear();};
}
