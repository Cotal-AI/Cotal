import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from './scenarios.mjs';

function results(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...results(path));
    else if (name === 'result.json') found.push(JSON.parse(readFileSync(path, 'utf8')));
  }
  return found;
}

function cell(row) {
  const versions = row.from ? `${row.from} → ${row.version ?? '?'}` : row.version ?? '';
  const mark = row.outcome === 'passed' ? '✅' : row.outcome === 'skipped' ? '⏭️' : '❌';
  const text = `${mark} ${row.outcome === 'missing' ? 'no result' : versions}`.trim();
  return row.outcome === 'passed' || !row.run ? text : `[${text}](${row.run})`;
}

/**
 * One Markdown table, scenario by system, then one line for each cell that did not pass. Every
 * expected cell without a result counts as a failure, so a job that died early cannot vanish.
 */
export function table(directory, runUrl, expect = {}) {
  const rows = results(directory).map((row) => ({ ...row, system: row.system ?? row.os }));
  const systems = expect.systems ?? [...new Set(rows.map((row) => row.system))].sort();
  const names = expect.scenarios ?? SCENARIOS.map((row) => row.name).filter((name) => rows.some((row) => row.scenario === name));
  for (const scenario of names) {
    for (const system of systems) {
      if (!rows.some((row) => row.scenario === scenario && row.system === system)) {
        rows.push({ scenario, system, os: system, outcome: 'missing', reason: 'the job stopped before the scenario recorded a result', run: runUrl });
      }
    }
  }
  const counted = rows.filter((row) => names.includes(row.scenario) && systems.includes(row.system));
  const label = (system) => counted.find((row) => row.system === system && row.outcome !== 'missing')?.os ?? system;
  const title = (name) => SCENARIOS.find((row) => row.name === name)?.title ?? name;
  const lines = [`| Scenario | ${systems.map(label).join(' | ')} |`, `|---|${systems.map(() => '---').join('|')}|`];
  for (const name of names) {
    lines.push(`| ${title(name)} | ${systems.map((system) => cell(counted.find((row) => row.scenario === name && row.system === system))).join(' | ')} |`);
  }
  const failed = counted.filter((row) => row.outcome !== 'passed');
  const summary = [`${counted.length - failed.length} of ${counted.length} passed${runUrl ? ` in [this run](${runUrl})` : ''}.`];
  for (const row of failed) {
    const why = row.outcome === 'skipped' || row.outcome === 'missing' ? row.reason : row.failed?.[0] ?? row.reason?.split('\n')[0] ?? 'no result recorded';
    summary.push(`- **${title(row.scenario)}** on ${label(row.system)}: ${why}${row.run ? ` ([log](${row.run}))` : ''}`);
  }
  return `${lines.join('\n')}\n\n${summary.join('\n')}\n`;
}
