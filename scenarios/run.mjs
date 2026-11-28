#!/usr/bin/env node
// Runs one named starting setup against the published Cotal release on a disposable machine.
//   node scenarios/run.mjs list
//   node scenarios/run.mjs run <scenario> [--version <x.y.z|latest>] [--out <dir>] [--label <os label>] [--system <key>]
//   node scenarios/run.mjs table <results-dir> [--run-url <url>] [--expect-scenarios a,b] [--expect-systems x,y]
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Report, ScenarioFailed } from './lib/report.mjs';
import { SCENARIOS } from './lib/scenarios.mjs';
import { table } from './lib/table.mjs';

const MARKER = process.platform === 'win32' ? 'C:\\ProgramData\\cotal-scenario-machine' : '/etc/cotal-scenario-machine';

/** Scenarios install software system-wide and change the hosts file, so they run only on throwaway machines. */
function assertDisposable() {
  if (process.env.RUNNER_ENVIRONMENT === 'github-hosted') return 'github-hosted';
  if (existsSync(MARKER)) return 'test-vm';
  throw new Error(`refusing to run: this is not a GitHub-hosted runner and ${MARKER} does not exist. Run scenarios only on a disposable test machine (scenarios/machines).`);
}

async function platform() {
  const module = await import(`./lib/os-${process.platform}.mjs`).catch(() => {
    throw new Error(`no scenario support for ${process.platform}`);
  });
  return module.default;
}

async function runOne(name, values) {
  const scenario = SCENARIOS.find((row) => row.name === name);
  if (!scenario) throw new Error(`unknown scenario '${name}'. Known: ${SCENARIOS.map((row) => row.name).join(', ')}`);
  const machine = assertDisposable();
  const os = await platform();
  const out = resolve(values.out ?? join(process.cwd(), 'scenario-results', name));
  const downloads = join(out, 'downloads');
  mkdirSync(downloads, { recursive: true });
  const label = values.label ?? await os.label();
  const report = new Report(out, { scenario: name, title: scenario.title, os: label, system: values.system ?? label, platform: process.platform, arch: process.arch, machine, target: values.version, run: process.env.SCENARIO_JOB_URL });
  const ctx = { os, out, downloads, report, version: values.version };
  try {
    const left = os.leftovers(homedir());
    report.check('the machine starts clean', left.length === 0, left);
    await scenario.run(ctx);
    report.finish('passed');
  } catch (error) {
    report.finish('failed', error instanceof ScenarioFailed ? undefined : String(error?.stack ?? error));
  } finally {
    if (ctx.appPid) await os.quit(ctx.appPid).catch(() => {});
  }
  console.log(`${name}: ${report.data.outcome} (${join(out, 'result.json')})`);
  return report.data.outcome === 'passed';
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: 'string', default: 'latest' }, out: { type: 'string' }, label: { type: 'string' }, system: { type: 'string' },
    'run-url': { type: 'string' }, 'expect-scenarios': { type: 'string' }, 'expect-systems': { type: 'string' },
  },
});
const [command, arg] = positionals;
if (command === 'list') {
  for (const row of SCENARIOS) console.log(`${row.name.padEnd(12)} ${row.title}`);
} else if (command === 'run' && arg) {
  try {
    process.exitCode = (await runOne(arg, values)) ? 0 : 1;
  } catch (error) {
    console.error(`run.mjs: ${error.message}`);
    process.exitCode = 2;
  }
} else if (command === 'table' && arg) {
  const list = (text) => (text ? text.split(',').map((item) => item.trim()).filter(Boolean) : undefined);
  console.log(table(resolve(arg), values['run-url'], { scenarios: list(values['expect-scenarios']), systems: list(values['expect-systems']) }));
} else {
  console.error('usage: node scenarios/run.mjs list | run <scenario> [--version v] [--out dir] [--label text] [--system key] | table <dir> [--run-url url] [--expect-scenarios a,b] [--expect-systems x,y]');
  process.exitCode = 2;
}
