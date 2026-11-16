import test from 'node:test';
import assert from 'node:assert/strict';
import {install_random_uuid} from '../src/frame/crypto.mjs';

test('UUID fallback uses native random bytes and sets only version and variant bits', () => {
  let calls=0;
  class Crypto {
    getRandomValues(bytes) {
      if (!(this instanceof Crypto)) throw new TypeError('Illegal invocation');
      assert.equal(bytes.byteLength,16);calls++;
      for(let i=0;i<bytes.length;i++)bytes[i]=i*17;
      return bytes;
    }
  }
  const crypto=new Crypto();install_random_uuid(crypto);
  assert.equal(crypto.randomUUID(),'00112233-4455-4677-8899-aabbccddeeff');
  assert.equal(calls,1);
  assert.throws(()=>crypto.randomUUID.call({}),TypeError);
  assert.equal(crypto.randomUUID.name,'randomUUID');assert.equal(crypto.randomUUID.length,0);
});

test('Native UUID implementations remain intact and no fallback is installed without a CSPRNG', () => {
  const native=()=> 'native';
  class Crypto {randomUUID=native;getRandomValues(){throw new Error('unused');}}
  const crypto=new Crypto();install_random_uuid(crypto);assert.equal(crypto.randomUUID,native);
  class Empty {}
  const empty=new Empty();install_random_uuid(empty);assert.equal(empty.randomUUID,undefined);
  install_random_uuid(undefined);
});
