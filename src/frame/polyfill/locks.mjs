import * as loader from '../loader.mjs';
import * as rpc from '../../rpc.mjs';
import {create_lock_api} from '../../locks/client.mjs';
export const {locks,Lock,LockManager}=create_lock_api({
  open:(name,options,port)=>rpc.call_procedure(rpc.host,'lock_open',[loader.beacon_context,name,options,port],{transfer:[port]}),
  query:()=>rpc.call_procedure(rpc.host,'lock_query',[loader.beacon_context])
});
const NavigatorType=globalThis.Navigator||globalThis.WorkerNavigator;
if(NavigatorType)Object.defineProperty(NavigatorType.prototype,'locks',{configurable:true,enumerable:true,get(){
  if(!(this instanceof NavigatorType))throw new TypeError('Invalid navigator receiver');return locks;
}});
