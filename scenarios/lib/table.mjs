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
  const text = `${mark} ${versions}`.trim();
  return row.outcome === 'passed' || !row.run ? text : `[${text}](${row.run})`;
}

/** One Markdown table, scenario by OS, then one line for each scenario that did not pass. */
export function table(directory, runUrl) {
  const rows = results(directory);
  const systems = [...new Set(rows.map((row) => row.os))].sort();
  const names = [...SCENARIOS.map((row) => row.name), ...new Set(rows.map((row) => row.scenario))].filter((name, index, all) => all.indexOf(name) === index && rows.some((row) => row.scenario === name));
  const title = (name) => SCENARIOS.find((row) => row.name === name)?.title ?? name;
  const lines = [`| Scenario | ${systems.join(' | ')} |`, `|---|${systems.map(() => '---').join('|')}|`];
  for (const name of names) {
    const cells = systems.map((os) => rows.find((row) => row.scenario === name && row.os === os));
    lines.push(`| ${title(name)} | ${cells.map((row) => (row ? cell(row) : '')).join(' | ')} |`);
  }
  const failed = rows.filter((row) => row.outcome !== 'passed');
  const passed = rows.length - failed.length;
  const summary = [`${passed} of ${rows.length} passed${runUrl ? ` in [this run](${runUrl})` : ''}.`];
  for (const row of failed) {
    const why = row.outcome === 'skipped' ? row.reason : row.failed?.[0] ?? row.reason?.split('\n')[0] ?? 'no result recorded';
    summary.push(`- **${title(row.scenario)}** on ${row.os}: ${why}${row.run ? ` ([log](${row.run}))` : ''}`);
  }
  return `${lines.join('\n')}\n\n${summary.join('\n')}\n`;
}
