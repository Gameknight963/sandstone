export function redirect_url(location,current){
  const previous=new URL(current),next=new URL(location,previous);
  if(!/^https?:$/.test(next.protocol))throw new TypeError('Invalid redirect URL');
  // An explicit fragment, including an empty one, replaces the old fragment.
  // Otherwise carry navigation state through the redirect chain.
  if(!next.href.includes('#'))next.hash=previous.hash;
  return next;
}
