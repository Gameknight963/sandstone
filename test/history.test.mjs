import test from "node:test";
import assert from "node:assert/strict";
import { NavigationHistory, history_url } from "../src/history.mjs";

test('JavaScript document replacement preserves cloned state while creating a new document in the current entry',()=>{
  const history=new NavigationHistory();history.navigate('https://example.com/start');
  history.mutate('push',{bytes:new Uint8Array([3,4])},'https://example.com/current');
  history.mutate('push',{forward:true},'https://example.com/forward');history.go(-1);
  const before=history.snapshot();
  const after=history.navigate(before.url,{mode:'replace',preserve_state:true});
  assert.equal(after.length,before.length);assert.equal(after.index,before.index);assert.equal(after.url,before.url);
  assert.notEqual(after.document_id,before.document_id);assert.deepEqual(after.state,before.state);
  before.state.bytes[0]=99;after.state.bytes[1]=99;assert.deepEqual([...history.snapshot().state.bytes],[3,4]);
  assert.equal(history.go(1).state.forward,true);assert.equal(history.go(-1).sameDocument,false);assert.equal(history.go(-1).sameDocument,false);
});

test("Session history clones state and supports same-document traversal", () => {
  const history = new NavigationHistory();
  history.navigate("https://example.com/app");
  const state = {page: 1, bytes: new Uint8Array([1, 2])};
  history.mutate("push", state, "https://example.com/app?one", [0, 100]);
  state.page = 99;
  history.mutate("push", {page: 2}, "https://example.com/app?two#section", [0, 200]);
  const previous = history.go(-1, [0, 300]);
  assert.equal(previous.sameDocument, true);
  assert.equal(previous.state.page, 1);
  assert.deepEqual([...previous.state.bytes], [1, 2]);
  assert.deepEqual(previous.scroll, [0, 200]);
  previous.state.page = 88;
  assert.equal(history.snapshot().state.page, 1);
  const forward = history.go(1, [0, 400]);
  assert.equal(forward.state.page, 2);
  assert.equal(forward.length, 3);
  assert.deepEqual(forward.scroll, [0, 300]);
});

test("Replacing an entry and pushing after back truncate forward history correctly", () => {
  const history = new NavigationHistory();
  history.navigate("https://example.com/");
  history.mutate("push", {page: 1}, "https://example.com/one");
  history.mutate("push", {page: 2}, "https://example.com/two");
  history.go(-1);
  history.mutate("replace", {page: 3}, "https://example.com/replaced");
  assert.equal(history.snapshot().length, 3);
  history.mutate("push", undefined, "https://example.com/new");
  assert.equal(history.snapshot().length, 3);
  assert.equal(history.snapshot().state, undefined);
  assert.equal(history.go(1), null);
});

test("Cross-document restoration retains state and reconnects same-document entries", () => {
  const history = new NavigationHistory();
  history.navigate("https://example.com/app");
  history.mutate("push", {page: 1}, "https://example.com/app?one");
  history.mutate("push", {page: 2}, "https://example.com/app?two");
  history.navigate("https://other.test/");
  const previous = history.go(-1);
  assert.equal(previous.sameDocument, false);
  history.navigate(previous.url, {mode: "traverse"});
  assert.equal(history.snapshot().state.page, 2);
  assert.equal(history.snapshot().length, 4);
  assert.equal(history.go(-1).sameDocument, true);
  history.navigate(history.current.url, {mode: "reload"});
  assert.equal(history.snapshot().state.page, 1);
  assert.equal(history.snapshot().length, 4);
  assert.equal(history.go(1).sameDocument, true);
});

test("History state rejects cross-origin URLs, credential changes and unclonable values", () => {
  const current = "https://example.com/app#old";
  assert.equal(history_url(undefined, current), current);
  assert.equal(history_url(null, current), current);
  assert.equal(history_url("", current), current);
  assert.equal(history_url("?new", current), "https://example.com/app?new");
  assert.throws(() => history_url("https://other.test/", current), {name: "SecurityError"});
  assert.throws(() => history_url("https://user@example.com/", current), {name: "SecurityError"});
  const history = new NavigationHistory();
  history.navigate(current);
  assert.throws(() => history.mutate("push", () => {}, current), {name: "DataCloneError"});
  assert.equal(history.snapshot().length, 1);
});
