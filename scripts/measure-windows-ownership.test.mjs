import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

test('installed core ESM entry is readable without CommonJS exports', async () => {
  const packageRoot = fileURLToPath(new URL('../bin', import.meta.url));
  const coreRoot = realpathSync(join(packageRoot, 'node_modules', '@cotal-ai/core'));
  const pkg = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8'));
  const cli = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@cotal-ai/core');
  assert.equal(pkg.version, cli.version);
  const core = await import(pathToFileURL(join(coreRoot, pkg.exports['.'].import)).href);
  assert.equal(typeof core.mkSecretDir, 'function');
});

test('observation hook reaches native calls inside the unchanged eval-worker pattern', () => {
  const root = mkdtempSync(join(tmpdir(), 'ownership-hook-'));
  try {
    const log = join(root, 'timing.jsonl');
    const hook = new URL('./measure-windows-ownership-hook.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', `
      import { Worker } from 'node:worker_threads';
      process.execArgv = ['--max-semi-space-size=1'];
      const worker = new Worker(\`
        const { parentPort, workerData } = require('node:worker_threads');
        process.execArgv = workerData.execArgv;
        import('node:child_process').then(({ spawnSync }) => {
          const result = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
          parentPort.postMessage(result.status);
        });
      \`, { eval: true, workerData: { execArgv: process.execArgv } });
      worker.once('message', code => { if (code !== 0) process.exitCode = 1; });
    `], { env: { ...process.env, OWNERSHIP_TIMING_LOG: log }, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.kind === 'worker-start'));
    assert.ok(events.some(e => e.kind === 'preload' && e.threadId !== 0));
    assert.ok(events.some(e => e.kind === 'module' && e.threadId !== 0));
    assert.ok(events.some(e => e.kind === 'native-end' && e.threadId !== 0 && e.status === 0));
  } finally {
    rmSync(root, { recursive: true });
  }
});
