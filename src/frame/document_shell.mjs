import {Parser,defaultTreeAdapter} from 'parse5';

// A javascript: string result must first create a real native Document. Return
// only a fixed, resource-free shell; the full source is materialized by the
// relay afterward. Native layout mode cannot be changed by inserting a doctype.
export function javascript_document_shell(source){
  let mode='quirks',parser;
  const treeAdapter={...defaultTreeAdapter,setDocumentMode(document,value){
    mode=value;defaultTreeAdapter.setDocumentMode(document,value);
    parser.tokenizer.pause();
  }};
  parser=new Parser({treeAdapter});
  parser.tokenizer.write(source,true);
  const doctype=mode==='quirks'?'':mode==='limited-quirks'?'<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">':'<!doctype html>';
  return doctype+'<html><head></head><body></body></html>';
}
