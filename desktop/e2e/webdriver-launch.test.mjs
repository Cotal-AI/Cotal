import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { WindowDriver } = await tsImport('./webdriver.ts', import.meta.url);
const source = readFileSync(new URL('./webdriver.ts', import.meta.url), 'utf8');

async function fixture(t, failSession = false) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    requests.push({ method: request.method, path: request.url, body: text ? JSON.parse(text) : null });
    response.setHeader('content-type', 'application/json');
    if (failSession && request.url === '/session') {
      response.statusCode = 500;
      response.end(JSON.stringify({ value: { error: 'session not created', message: 'controlled attach failure' } }));
    } else response.end(JSON.stringify({ value: request.url === '/session' ? { sessionId: 'owned-session' } : null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const log = join(mkdtempSync(join(tmpdir(), 'windows-webdriver-')), 'launch.jsonl');
  const driver = new WindowDriver(`http://127.0.0.1:${server.address().port}`, log);
  return { requests, log, driver };
}

test('actual open request preserves plain args and logs only their shapes', async t => {
  const { requests, log, driver } = await fixture(t);
  const link = 'cotal://connect?idp=http%3A%2F%2F127.0.0.1%3A9%2FSECRET&space=PRIVATE';
  await driver.open('C:\\owned\\cotal-desktop.exe', [link, '--background', '--credential=SECRET']);
  assert.deepEqual(requests[0].body, { capabilities: { alwaysMatch: { 'tauri:options': {
    application: 'C:\\owned\\cotal-desktop.exe', args: [link, '--background', '--credential=SECRET'],
  } } } });
  const evidence = readFileSync(log, 'utf8');
  assert.doesNotMatch(evidence, /SECRET|PRIVATE|credential|cotal:\/\//);
  const receipt = JSON.parse(evidence.trim());
  assert.deepEqual(receipt.capabilities.alwaysMatch['tauri:options'].args[0], {
    bytes: Buffer.byteLength(link), leadingDashes: false, redacted: true,
  });
  await driver.close();
  assert.equal(requests.at(-1).method, 'DELETE');
});

test('actual attach request uses native Edge debugger capabilities without launching arguments', async t => {
  const { requests, log, driver } = await fixture(t);
  await driver.attachWindows(9223);
  assert.deepEqual(requests[0].body, { capabilities: { alwaysMatch: {
    browserName: 'webview2', 'ms:edgeChromium': true, 'ms:edgeOptions': { debuggerAddress: '127.0.0.1:9223' },
  } } });
  assert.doesNotMatch(JSON.stringify(requests[0].body), /tauri:options|binary|args/);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()).capabilities, requests[0].body.capabilities);
  assert.equal(requests[1].path, '/session/owned-session/timeouts');
  await driver.close();
});

test('invalid attach ports never reach the server', async t => {
  const { requests, driver } = await fixture(t);
  for (const port of [-1, 0, 65536, 1.5, NaN]) await assert.rejects(driver.attachWindows(port));
  assert.equal(requests.length, 0);
});

test('failed attach and failed session deletion still reap only the retained owned child', async t => {
  const { driver } = await fixture(t, true);
  let killed = 0;
  const child = { pid: 42, exitCode: null, signalCode: null,
    kill() { killed++; this.signalCode = 'SIGTERM'; return true; } };
  // TypeScript private storage is intentionally exercised here, not a native launch substitute.
  driver.application = child;
  await assert.rejects(driver.attachWindows(9223), /controlled attach failure/);
  await driver.close();
  assert.equal(killed, 1);
  assert.equal(driver.application, undefined);
  driver.application = { ...child, signalCode: null };
  driver.session = 'owned-session';
  driver.call = async () => { throw new Error('controlled DELETE failure'); };
  await assert.rejects(driver.close(), /controlled DELETE failure/);
  assert.equal(killed, 2);
  assert.equal(driver.session, undefined);
  assert.equal(driver.application, undefined);
});

test('spawn-error and already exited children are not killed, failed kill retains ownership', async t => {
  const { driver } = await fixture(t);
  for (const child of [{ pid: undefined, exitCode: null, signalCode: null }, { pid: 42, exitCode: 0, signalCode: null }]) {
    driver.application = { ...child, kill() { throw new Error('must not kill'); } };
    await driver.close();
    assert.equal(driver.application, undefined);
  }
  const child = { pid: 42, exitCode: null, signalCode: null, kill() { throw new Error('controlled kill failure'); } };
  driver.application = child;
  await assert.rejects(driver.close(), /controlled kill failure/);
  assert.equal(driver.application, child);
});

test('plain launch pins exact binary, child, fresh argv and listener generation before attach', () => {
  assert.match(source, /spawn\(binary, \[link\]/);
  assert.match(source, /const binary = realpathSync\(application\)/);
  assert.match(source, /row.pid === child.pid && row.atUnixMs >= started/);
  assert.match(source, /subarray\(receiptOffset\)/);
  assert.match(source, /row.values\[0\]\?\.url === "cotal:\/\/connect"/);
  assert.match(source, /leadingDashes, false/);
  assert.match(source, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=\$\{port\} --remote-debugging-address=127.0.0.1`/);
  assert.match(source, /ExecutablePath -ne/);
  assert.match(source, /CreationDate/);
  assert.match(source, /\$created -lt \$birth -or \$created -gt \$youngest/);
  assert.match(source, /Import-Module NetTCPIP; Import-Module CimCmdlets/);
  assert.ok(source.indexOf('await verifyWindowsDebuggerOwner') < source.indexOf('await this.attachWindows(port)'));
  assert.doesNotMatch(source, /taskkill|Stop-Process|Set-ItemProperty|Start-Process|shell: true/);
});

test('scenario preserves deep-link context and no-approval assertions', () => {
  const scenario = readFileSync(new URL('./first-run.ts', import.meta.url), 'utf8');
  assert.match(scenario, /process.platform === "win32" && args.length === 1 && args\[0\].startsWith\("cotal:\/\/"\)/);
  assert.match(scenario, /driver.openWindowsLink\(binary, args\[0\], \{ env: guiEnv/);
  assert.match(scenario, /until\("deep link visible", \(\) => driver.displayed\("link-context"\), Boolean\)/);
  assert.match(scenario, /fixture.requests\(\) === before && !\(await status\(\)\).managers.some/);
  assert.match(scenario, /value.length===1&&value\[0\]===expected/);
  assert.match(scenario, /Windows deep-link plugin retains the intended public URL", exactLink === true/);
});

test('Windows plain-link admission reads the native trace output, not the daemon home', () => {
  const scenario = readFileSync(new URL('./first-run.ts', import.meta.url), 'utf8');
  assert.match(scenario, /traceHome: process.platform === "win32" \? output : daemonHome/);
  assert.match(scenario, /driver.openWindowsLink\(binary, args\[0\], \{ env: guiEnv, cwd: home, receipts: join\(output, "deep-link-receipts.jsonl"\) \}\)/);
  assert.doesNotMatch(scenario, /receipts: join\(daemonHome, "deep-link-receipts.jsonl"\)/);
});
