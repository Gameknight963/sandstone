import {randomInt} from 'node:crypto';
import {once} from 'node:events';

// Some Windows dynamic port ranges include ports blocked by browsers.
// Use the high dynamic range, above the Fetch bad-port table:
// https://fetch.spec.whatwg.org/#port-blocking
export async function listen_browser_server(server,host='127.0.0.1'){
  let failure;
  for(let attempt=0;attempt<32;attempt++){
    try{
      server.listen(randomInt(49152,65536),host);
      await once(server,'listening');
      return;
    }catch(error){
      if(error.code!=='EADDRINUSE'&&error.code!=='EACCES')throw error;
      failure=error;
    }
  }
  throw failure;
}
