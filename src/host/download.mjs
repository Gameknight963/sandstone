import {download_filename} from '../download.mjs';

export function save_blob(blob,filename) {
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=filename;link.hidden=true;
  document.body.append(link);
  try{link.click();}finally{
    link.remove();
    const timer=setTimeout(()=>URL.revokeObjectURL(url),60000);timer.unref?.();
  }
}

export class Downloads {
  constructor({fetch,contexts,cookies,save=save_blob}) {Object.assign(this,{fetch,contexts,cookies,save});}
  context(id) {
    const entry=this.contexts.get(id);
    if(!entry)throw new TypeError('Unknown download document');
    return {...entry.context,navigation:true};
  }
  async request(id,url,hint,options={}) {
    const context=this.context(id),target=new URL(url);
    if(!/^https?:$/.test(target.protocol))throw new TypeError('Download URL must use HTTP or HTTPS');
    let referrer=context.url;
    try{if(new URL(options.referrer).origin===new URL(context.url).origin)referrer=options.referrer;}catch{}
    const response=await this.fetch(target.href,{mode:'navigate',credentials:'include',referrerPolicy:options.referrerPolicy,referrer},context);
    const filename=await this.response(response,target.href,hint);
    return {filename,cookies:this.cookies?.(context.url,context)};
  }
  async response(response,url,hint) {
    if(!response.ok){await response.body?.cancel();throw new TypeError('Download failed: '+response.status);}
    const name=download_filename(response.url||url,response.headers.get('content-disposition'),hint);
    await this.save(await response.blob(),name);
    return name;
  }
  async blob(id,blob,name) {
    this.context(id);
    if(!(blob instanceof Blob))throw new TypeError('Download data must be a Blob');
    const filename=download_filename('',null,name);
    await this.save(blob,filename);return filename;
  }
}
