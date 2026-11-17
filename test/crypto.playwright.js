async page => {
  await page.evaluate(async()=>{
    main_frame.special_pages['https://fixture.test/crypto/']='<!doctype html><title>Crypto fixture</title><body>Crypto fixture</body>';
    await main_frame.navigate_to('https://fixture.test/crypto/');
  });
  const result=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`(async()=>{
    const bytes=value=>new TextEncoder().encode(value),hex=value=>Array.from(new Uint8Array(value),byte=>byte.toString(16).padStart(2,'0')).join('');
    const digest=hex(await crypto.subtle.digest('SHA-256',bytes('abc')));
    window.fixtureCryptoKey=await crypto.subtle.importKey('raw',bytes('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
    const signature=await crypto.subtle.sign('HMAC',fixtureCryptoKey,bytes('message'));
    const signed=await crypto.subtle.verify('HMAC',fixtureCryptoKey,signature,bytes('message'));
    const encryptionKey=await crypto.subtle.generateKey({name:'AES-GCM',length:128},false,['encrypt','decrypt']);
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:new Uint8Array(12)},encryptionKey,bytes('encrypted payload'));
    const decrypted=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)},encryptionKey,encrypted));
    const damaged=new Uint8Array(encrypted);damaged[0]^=1;
    let tampered;try{await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)},encryptionKey,damaged);}catch(error){tampered=error.name;}
    let restriction;try{await crypto.subtle.exportKey('raw',fixtureCryptoKey);}catch(error){restriction=error.name;}
    const value={key:fixtureCryptoKey,again:fixtureCryptoKey,map:new Map([[fixtureCryptoKey,new Set([fixtureCryptoKey])]])};value.self=value;
    const copy=structuredClone(value);
    const cloned=copy.key instanceof CryptoKey&&copy.key===copy.again&&copy.self===copy&&copy.map.get(copy.key).has(copy.key)&&hex(await crypto.subtle.sign('HMAC',copy.key,bytes('message')))===hex(signature);
    const channel=new MessageChannel();
    const message=new Promise(resolve=>channel.port2.onmessage=async event=>{const value=event.data;resolve(value.key instanceof CryptoKey&&hex(await crypto.subtle.sign('HMAC',value.key,bytes('message')))===hex(signature));channel.port1.close();channel.port2.close();});
    channel.port1.postMessage({key:fixtureCryptoKey});
    const messageKey=await message;
    const request=indexedDB.open('crypto-fixture',1);
    const database=await new Promise((resolve,reject)=>{request.onupgradeneeded=()=>request.result.createObjectStore('keys');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const tx=database.transaction('keys','readwrite');tx.objectStore('keys').put({key:fixtureCryptoKey},'saved');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});database.close();
    return JSON.stringify({digest,signed,decrypted,tampered,restriction,cloned,messageKey,keyType:fixtureCryptoKey.type,extractable:fixtureCryptoKey.extractable,tag:Object.prototype.toString.call(fixtureCryptoKey),subtleTag:Object.prototype.toString.call(crypto.subtle),signature:hex(signature)});
  })()`)));
  if(result.digest!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'||!result.signed||result.decrypted!=='encrypted payload'||result.tampered!=='OperationError'||!result.cloned||!result.messageKey||result.extractable||result.keyType!=='secret'||result.tag!=='[object CryptoKey]'||result.subtleTag!=='[object SubtleCrypto]'||!/^InvalidAccess/.test(result.restriction))throw new Error('Sandbox Web Crypto failed: '+JSON.stringify(result));
  const nativeMethods=await page.evaluate(()=>Object.getOwnPropertyNames(Object.getPrototypeOf(crypto.subtle)).filter(name=>name!=='constructor').sort());
  const virtualMethods=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`JSON.stringify(Object.getOwnPropertyNames(SubtleCrypto.prototype).filter(name=>name!=='constructor').sort())`)));
  if(JSON.stringify(nativeMethods)!==JSON.stringify(virtualMethods))throw new Error('Web Crypto method surface differs from the host: '+JSON.stringify({nativeMethods,virtualMethods}));
  const modern=await page.evaluate(async()=>{
    if(!crypto.subtle.encapsulateBits)return false;
    try{await crypto.subtle.generateKey('ML-KEM-768',false,['encapsulateBits','decapsulateBits']);return true;}
    catch(error){if(error.name==='NotSupportedError')return false;throw error;}
  });
  if(modern){
    const encapsulated=await page.evaluate(()=>main_frame.eval_js(`(async()=>{
      const pair=await crypto.subtle.generateKey('ML-KEM-768',false,['encapsulateBits','decapsulateBits','encapsulateKey','decapsulateKey']);
      const publicKey=await crypto.subtle.getPublicKey(pair.privateKey,['encapsulateBits','encapsulateKey']);
      const value=await crypto.subtle.encapsulateBits('ML-KEM-768',publicKey);
      const decoded=await crypto.subtle.decapsulateBits('ML-KEM-768',pair.privateKey,value.ciphertext);
      const key=await crypto.subtle.encapsulateKey('ML-KEM-768',publicKey,'AES-GCM',true,['encrypt']);
      const restored=await crypto.subtle.decapsulateKey('ML-KEM-768',pair.privateKey,key.ciphertext,'AES-GCM',true,['decrypt']);
      const hex=buffer=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
      return hex(value.sharedKey)===hex(decoded)&&hex(await crypto.subtle.exportKey('raw',key.sharedKey))===hex(await crypto.subtle.exportKey('raw',restored));
    })()`));
    if(!encapsulated)throw new Error('Native modern key encapsulation failed through the broker');
  }

  const workerSource=`onmessage=async event=>{
    try{
      const key=event.data,bytes=new TextEncoder().encode('message');
      const signature=await crypto.subtle.sign('HMAC',key,bytes);
      postMessage({key,signature,typed:key instanceof CryptoKey});
    }catch(error){postMessage({error:error.name+': '+error.message});}
  };`;
  const worker=JSON.parse(await page.evaluate(source=>main_frame.eval_js(`new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'})),worker=new Worker(url);
    worker.onmessage=async event=>{worker.terminate();URL.revokeObjectURL(url);const value=event.data;resolve(JSON.stringify({error:value.error,typed:value.typed,returned:value.key instanceof CryptoKey,signature:value.signature?Array.from(new Uint8Array(value.signature),byte=>byte.toString(16).padStart(2,'0')).join(''):''}));};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};worker.postMessage(fixtureCryptoKey);
  })`),workerSource));
  if(worker.error||!worker.typed||!worker.returned||worker.signature!==result.signature)throw new Error('Worker cryptographic key transfer failed: '+JSON.stringify(worker));

  await page.evaluate(()=>main_frame.navigate_to('https://fixture.test/crypto/'));
  const restored=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`(async()=>{
    const request=indexedDB.open('crypto-fixture');
    const database=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const stored=await new Promise((resolve,reject)=>{const request=database.transaction('keys').objectStore('keys').get('saved');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});database.close();
    const signature=await crypto.subtle.sign('HMAC',stored.key,new TextEncoder().encode('message'));
    return JSON.stringify({typed:stored.key instanceof CryptoKey,extractable:stored.key.extractable,signature:Array.from(new Uint8Array(signature),byte=>byte.toString(16).padStart(2,'0')).join('')});
  })()`)));
  if(!restored.typed||restored.extractable||restored.signature!==result.signature)throw new Error('Persisted cryptographic key failed: '+JSON.stringify(restored));
  const persisted=await page.evaluate(async()=>{
    const database=await new Promise((resolve,reject)=>{const request=indexedDB.open('sandstone:idb:'+JSON.stringify(['https://fixture.test','crypto-fixture']));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{return await new Promise((resolve,reject)=>{const request=database.transaction('s:keys').objectStore('s:keys').get('saved');request.onsuccess=()=>resolve(request.result?.key instanceof CryptoKey&&!request.result.key.extractable);request.onerror=()=>reject(request.error);});}
    finally{database.close();}
  }).catch(()=>null);
  // Denied-storage mode uses the host's in-memory IDB fallback instead.
  if(persisted===false)throw new Error('The host stored a key marker instead of a native nonextractable CryptoKey');
  return ['Web Crypto hashing/signing and nonextractable key permissions','CryptoKey structured cloning, MessagePorts and worker transfers','Native cryptographic key persistence through origin-scoped IndexedDB'];
}
