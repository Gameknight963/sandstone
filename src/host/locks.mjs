import {LockService} from '../locks/service.mjs';
import {beacons} from './network.mjs';
import {rpc_handlers} from '../rpc.mjs';
export const lock_service=new LockService({contexts:()=>beacons.contexts});
rpc_handlers.lock_open=(token,name,options,port)=>{
  if(!(port instanceof MessagePort))throw new TypeError('Invalid lock port');
  try{lock_service.open(token,name,options,port);}catch(error){port.close();throw error;}
};
rpc_handlers.lock_query=token=>lock_service.query(token);
