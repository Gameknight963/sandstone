import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'parse5';
import {javascript_document_shell} from '../src/frame/document_shell.mjs';

test('JavaScript result shells preserve native HTML layout modes without installing source resources',()=>{
  const sources=[
    '', 'plain text', '<!-- comment -->\n<body>', '<!doctype html>', '\ufeff<!doctype HTML>',
    '<!doctype html SYSTEM "about:legacy-compat">',
    '<!doctype HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">',
    '<!doctype HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">',
    '<!doctype HTML PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<!doctype html PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">',
    '<?xml version="1.0"?><!doctype html>', '<!doctype html><script>throw Error("raw source ran")</script>',
    '<!doctype html SYSTEM "https://direct.test/dtd"><link rel="stylesheet" href="https://direct.test/style"><img src="https://direct.test/image">'
  ];
  for(const source of sources){
    const shell=javascript_document_shell(source);
    assert.equal(parse(shell).mode,parse(source).mode,source);
    assert.ok(!/script|link|img|https:\/\/direct/.test(shell),source);
    assert.ok(shell.endsWith('<html><head></head><body></body></html>'),source);
  }
});
