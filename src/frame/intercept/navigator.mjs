import {create_beacon_sender} from '../beacon.mjs';
import {ctx} from '../context.mjs';
import * as loader from '../loader.mjs';
import * as rpc from '../../rpc.mjs';
import {load_cookies} from '../polyfill/cookie.mjs';
import {document_referrer_policy} from './document.mjs';
import {keepalive_budget} from '../keepalive_budget.mjs';

if (typeof Navigator !== 'undefined') {
  const send = create_beacon_sender({
    budget:keepalive_budget,
    base: () => ctx.document.baseURI,
    dispatch(url, body) {
      const referrer=/^about:blank(?:#|$)/.test(ctx.location.href)?'':undefined;
      return rpc.call_procedure(rpc.host, 'beacon', [loader.beacon_context, url, body,{referrer,referrerPolicy:document_referrer_policy()}]).then(result => load_cookies(result?.cookies));
    }
  });
  Navigator.prototype.sendBeacon = function sendBeacon(url, body) {
    if (!(this instanceof Navigator)) throw new TypeError('Invalid navigator receiver');
    return Reflect.apply(send, this, arguments);
  };
}
