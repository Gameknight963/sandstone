const feature='focus-without-user-activation';
const origin=value=>{try{return new URL(value).origin;}catch{return 'null';}};

// Physical opaque origins cannot match an author's HTTP origin allowlist.
// Resolve this one offline capability against the virtual document instead.
export function iframe_focus_policy(allow,{parent,document,source,opaque=false,defaultAll=false}){
  const directives=(allow||'').split(';'),index=directives.findIndex(value=>value.trim().split(/\s+/)[0]===feature);
  const address=origin(document),target=opaque?'null':address,creator=origin(parent),src=origin(source);
  let allowed=index<0&&target!=='null'&&(defaultAll||target===creator);
  if(index>=0){
    const tokens=directives[index].trim().split(/\s+/).slice(1);
    if(!tokens.length)tokens.push("'src'");
    allowed=tokens.some(token=>token==='*'||token==="'src'"&&address===src||target!=='null'&&(
      token==="'self'"&&target===creator||!token.startsWith("'")&&origin(token)===target
    ));
  }
  const resolved=feature+' '+(allowed?'*':"'none'");
  if(index<0)directives.push(resolved);else directives[index]=resolved;
  return directives.filter(value=>value.trim()).join('; ');
}
