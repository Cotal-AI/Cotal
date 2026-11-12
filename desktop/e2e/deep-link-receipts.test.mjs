import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const read = name => readFileSync(new URL(`../src-tauri/src/${name}`, import.meta.url), 'utf8');
const app = read('app.rs');
const lib = read('lib.rs');
const helper = read('e2e_deep_link.rs');
test('receipt module and every entry point require both gates', () => {
  assert.match(lib, /#\[cfg\(all\(feature = "e2e", debug_assertions\)\)\]\s*mod e2e_deep_link;/);
  assert.match(lib, /cfg\(all\(feature = "e2e", not\(debug_assertions\)\)\)\]\s*compile_error!/);
  for (const source of ['process-argv', 'single-instance']) {
    assert.match(app, new RegExp(`#\\[cfg\\(all\\(feature = "e2e", debug_assertions\\)\\)\\]\\s*crate::e2e_deep_link::receipt\\("${source}"`));
  }
  assert.match(app, /#\[cfg\(all\(feature = "e2e", debug_assertions\)\)\]\s*\{\s*use tauri_plugin_deep_link::DeepLinkExt;/);
  assert.match(app, /on_open_url\(\|event\|/);
  assert.match(app, /get_current\(\)/);
  assert.match(app, /if !args.iter\(\).any\(\|arg\| arg == "--background"\) \{ show\(app\); \}/);
});
test('sanitizer has no input URL or arbitrary argument serialization', () => {
  const sanitizer = helper.slice(helper.indexOf('fn safe_argument'), helper.indexOf('pub fn receipt'));
  const jsonOutputs = [...sanitizer.matchAll(/json!\((.*?)\)/g)].map(m => m[1]);
  assert.equal(jsonOutputs.length, 3);
  assert.equal(jsonOutputs.filter(v => v.includes('value')).length, 1);
  assert.match(sanitizer, /matches!\(value, "--background" \| "--daemon-home"\)/);
  assert.match(sanitizer, /"url": "cotal:\/\/connect"/);
  assert.match(sanitizer, /url.username\(\).is_empty\(\) && url.password\(\).is_none\(\)/);
  assert.match(sanitizer, /json!\(\{"redacted": true\}\)/);
  assert.doesNotMatch(sanitizer, /query_pairs|url\.to_string|url\.as_str|format!/);
  assert.match(helper, /map\(\|v\| safe_argument\(&v\)\)/);
  assert.match(helper, /home.join\("deep-link-receipts.jsonl"\)/);
  assert.match(helper, /token=SECRET&space=PRIVATE#SECRET/);
});
