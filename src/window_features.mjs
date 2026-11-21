// Window feature booleans use HTML's legacy integer/yes/true rules. Duplicate
// names replace earlier values; noreferrer also implies noopener.
const integer=Number.parseInt;
export function window_features(source){
  const values={noopener:false,noreferrer:false};let index=0;
  const space=character=>/[\t\n\f\r ]/.test(character||'');
  while(index<source.length){
    while(index<source.length&&(space(source[index])||source[index]===','))index++;
    const start=index;while(index<source.length&&!space(source[index])&&source[index]!==','&&source[index]!=='=')index++;
    const name=source.slice(start,index).toLowerCase();
    while(space(source[index]))index++;
    let value='';
    if(source[index]==='='){index++;while(space(source[index]))index++;const start=index;while(index<source.length&&!space(source[index])&&source[index]!==',')index++;value=source.slice(start,index).toLowerCase();}
    if(name==='noopener'||name==='noreferrer')values[name]=value===''||value==='yes'||value==='true'||!!integer(value,10);
    if(index===start)index++;
  }
  values.noopener ||= values.noreferrer;return values;
}
