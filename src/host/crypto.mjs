import {CryptoService} from '../crypto/service.mjs';
import {rpc_handlers} from '../rpc.mjs';
import {iframes} from './controller.mjs';

export const crypto_service = new CryptoService();
rpc_handlers.crypto = async (id, method, args) => {
  if (!iframes[id]) throw new TypeError('Unknown frame');
  return crypto_service.call(method,args);
};
