import {BroadcastService} from '../broadcast/service.mjs';
import {beacons} from './network.mjs';
import {crypto_service} from './crypto.mjs';
import {rpc_handlers} from '../rpc.mjs';

export const broadcast_channels=new BroadcastService({contexts:()=>beacons.contexts,
  encode:value=>crypto_service.encode_shared(value),decode:value=>crypto_service.decode_shared(value)});
rpc_handlers.broadcast_open=(context,id,name,port)=>{
  if(!(port instanceof MessagePort)||typeof name!=='string'||typeof id!=='string')throw new TypeError('Invalid broadcast channel');
  try{broadcast_channels.open(context,id,name,port);}catch(error){port.close();throw error;}
};
rpc_handlers.broadcast_command=(...args)=>broadcast_channels.command(...args);
