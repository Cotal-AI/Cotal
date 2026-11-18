import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Run only against a disposable test fixture app, never an existing personal installation.
// The fixture controller prepares Ready with one connected space and one unconnected space,
// can hold/release status reads, and can make the next read return an unknown-code refusal.
export async function proveDesktopDiagnostics({ app, driver, output, fixture, screenshot }) {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.ok(app.startsWith(process.env.RUNNER_TEMP + '/'), 'only an isolated runner-owned app is allowed');
  mkdirSync(output, { recursive: true });
  const call = (...args) => JSON.parse(execFileSync(driver, [app, ...args], { encoding: 'utf8' }));
  const text = () => JSON.stringify(call('dump'));
  await fixture('ready');
  call('click', 'another-space');
  call('click', 'space');
  await screenshot(join(output, 'native-space-picker.png'));
  writeFileSync(join(output, 'native-space-picker.json'), JSON.stringify(call('dump'), null, 2));
  // The runner's native fixture must inspect AXEnabled on the connected option,
  // rather than infer picker behavior from HTML hidden attributes.
  await fixture('assert-connected-option-disabled');
  await fixture('hold-status-and-select-unconnected');
  await fixture('assert-add-disabled');
  await fixture('release-status');
  await fixture('unknown-refusal-after-ready');
  assert.match(text(), /NEW_SERVICE_REFUSAL/);
  assert.match(text(), /Details/);
  await screenshot(join(output, 'unknown-refusal.png'));
  call('click', 'connection-status');
  assert.match(text(), /NEW_SERVICE_REFUSAL/);
  await screenshot(join(output, 'attention-reason.png'));
  await fixture('ready');
  call('click', 'open-settings');
  call('click', 'service-log');
  assert.match(text(), /fixture service log reason/);
  await screenshot(join(output, 'service-log.png'));
}
