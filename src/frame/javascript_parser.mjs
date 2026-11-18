import {parse as parse_primary} from 'meriyah';
import {parse as parse_fallback} from 'acorn';

// Some valid legacy scripts (notably arrow initializers in Annex B for-in
// loops) are rejected by Meriyah. Use a second strict parser, never raw source,
// so those scripts still pass through the same scope and resource rewriting.
export function parse(source,options={}){
  try{return parse_primary(source,options)}catch(error){
    try{return parse_fallback(source,{
      ecmaVersion:'latest',sourceType:options.module?'module':'script',ranges:!!options.ranges,
      onComment:typeof options.onComment==='function'?(block,text)=>options.onComment(block?'MultiLine':'SingleLine',text):undefined
    })}catch{throw error}
  }
}
