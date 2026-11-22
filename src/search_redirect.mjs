// DuckDuckGo HTML results carry their destination in uddg. Navigating directly
// avoids the otherwise blank /l/ page and its script-dependent redirect.
const duckduckgo_hosts=new Set(['duckduckgo.com','www.duckduckgo.com','html.duckduckgo.com','lite.duckduckgo.com']);

export function search_destination(input){
  try{
    const redirect=new URL(input);
    if(!/^https?:$/.test(redirect.protocol)||!duckduckgo_hosts.has(redirect.hostname)||redirect.port||redirect.pathname!=='/l/')return input;
    const value=redirect.searchParams.get('uddg');
    if(!value)return input;
    // URLSearchParams decodes exactly once. Never promote an executable or
    // local URL supplied through a search-engine query parameter.
    const target=new URL(value);
    if(/^https?:$/.test(target.protocol))return target.href;
  }catch{}
  return input;
}
