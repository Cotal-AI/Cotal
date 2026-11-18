import assert from 'node:assert/strict';
import { nativeStub, scenarios } from './fixtures.mjs';
// Reuse the production-renderer harness, with native replies held at its existing boundary.
scenarios.splice(0, scenarios.length,
  ...['content', 'empty', 'error'].map(mode => ({ name: `service-log-${mode}`, state: { installed: true, signedIn: true, connected: true, logText: mode === 'content' ? 'daemon startup refused: local test reason\n' : '', logTruncated: mode === 'content', logError: mode === 'error' }, act: async page => {
    await page.click('#open-settings'); await page.click('#service-log summary');
  }, expect: async page => {
    assert.equal(await page.evaluate(() => window.__renderState.logReads), 1);
    assert.match(await page.locator('#service-log-status').textContent(), mode === 'content' ? /most recent 8 KB/ : mode === 'empty' ? /No background service log/ : /could not be read/);
    if (mode === 'content') assert.match(await page.locator('#service-log-text').textContent(), /local test reason/);
    await page.click('#refresh-log'); assert.equal(await page.evaluate(() => window.__renderState.logReads), 2);
  } })),
  { name: 'unknown-refusal-after-ready', state: { installed: true, signedIn: true, connected: true }, act: async page => {
    await page.locator('#connected-panel:visible').waitFor();
    await page.evaluate(() => { window.__renderState.offline = true; window.__renderState.offlineCode = 'NEW_SERVICE_REFUSAL'; });
    await page.click('#open-settings'); await page.click('#open-settings');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#recovery-panel:visible').waitFor();
  }, expect: async page => {
    const detail = await page.locator('#details').isVisible();
    console.log('REPRO unknown refusal Details visible:', detail);
    assert.equal(detail, true, 'refusal must retain visible Details after Ready');
    assert.match(await page.locator('#refusal-detail').textContent(), /NEW_SERVICE_REFUSAL\nThe background service did not answer/);
    await page.click('#connection-status');
    assert.equal(await page.locator('#details').evaluate(el => el.open), true);
  } },
  { name: 'connected-picker-status-race', state: { installed: true, signedIn: true, connected: true, multiple: true }, act: async page => {
    await page.click('#another-space');
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'daemon_request' && args.request.op === 'status' ? new Promise(resolve => { window.__releaseStatus = () => resolve(invoke(command, args)); }) : invoke(command, args);
      const select = document.querySelector('#space'); select.value = 'acme-team'; select.dispatchEvent(new Event('change'));
    });
  }, expect: async page => {
    const disabled = await page.locator('#connect').isDisabled();
    console.log('REPRO Add disabled during selected-space status read:', disabled);
    assert.equal(disabled, true, 'Add must stay disabled while selected-space status is pending');
  } },
  { name: 'connected-picker-choice', state: { installed: true, signedIn: true, connected: true, multiple: true }, act: async page => { await page.click('#another-space'); }, expect: async page => {
    const option = await page.locator('#space option[value="acme-team"]').evaluate(el => ({ hidden: el.hidden, disabled: el.disabled }));
    console.log('REPRO connected native option:', JSON.stringify(option));
    assert.equal(option.disabled, true, 'native picker must disable connected spaces instead of relying on hidden');
  } },
);
await import('./run.mjs');
