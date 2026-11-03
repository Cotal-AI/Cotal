import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createSuite, skipSuite } from '../bin/smoke/sentinel.mjs';

if (process.platform === 'win32') skipSuite('release workflow shell regression requires POSIX Bash');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/release-notes-detail.mjs');
const suite = createSuite();
const dirs = [];
const version = '9.8.7';
function fixture(changelog) {
  const dir = mkdtempSync(join(tmpdir(), 'cotal-release-notes-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/package.json'), JSON.stringify({ version }));
  if (changelog !== undefined) writeFileSync(join(dir, 'bin/CHANGELOG.md'), changelog);
  return dir;
}
function detail(dir, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  return result;
}

// Execute the workflow's actual shell body, replacing only the external GitHub client. The stub
// captures its notes-file input instead of publishing anything. No credentials enter this fixture.
function workflowBody() {
  const text = readFileSync(join(root, '.github/workflows/changesets.yml'), 'utf8');
  const step = text.indexOf('      - name: Cut the GitHub Release\n');
  if (step < 0) throw new Error('release step missing');
  const marker = '        run: |\n';
  const start = text.indexOf(marker, step);
  if (start < 0) throw new Error('release shell missing');
  const lines = [];
  for (const line of text.slice(start + marker.length).split('\n')) {
    if (line.trim() && !line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  if (!lines.some((line) => line.includes('gh release create'))) throw new Error('release shell was not extracted');
  return lines.join('\n');
}
function workflow(dir) {
  const tools = join(dir, 'tools'), temp = join(dir, 'temp'), scripts = join(dir, 'scripts');
  for (const path of [tools, temp, scripts]) mkdirSync(path);
  copyFileSync(script, join(scripts, 'release-notes-detail.mjs'));
  writeFileSync(join(tools, 'gh'), `#!/bin/sh
case "$1:$2" in
  release:view) exit 1 ;;
  release:list) printf 'v9.8.6\\n' ;;
  api:*) printf 'Generated PR notes\\n' ;;
  release:create)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--notes-file' ]; then shift; cp "$1" "$CAPTURE_FILE"; exit 0; fi
      shift
    done
    exit 2 ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  const captured = join(dir, 'captured-notes.md');
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', workflowBody()], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, RUNNER_TEMP: temp,
      GITHUB_REPOSITORY: 'fixture/repository', GITHUB_SHA: 'fixture-source', CAPTURE_FILE: captured },
  });
  if (result.error) throw result.error;
  return { ...result, notes: existsSync(captured) ? readFileSync(captured, 'utf8') : undefined };
}

try {
  const valid = fixture(`# Changelog\n\n## ${version}\n\n- abcdef1: A real summary\n\n  A second paragraph.\n\n- Updated dependencies\n\n## 9.8.6\n\n- An older change\n`);
  mkdirSync(join(valid, 'packages', 'copy'), { recursive: true });
  copyFileSync(join(valid, 'bin/CHANGELOG.md'), join(valid, 'packages/copy/CHANGELOG.md'));
  const good = detail(valid, version);
  suite.check('valid release succeeds', good.status === 0, good.stderr);
  suite.check('summary appears once across packages', good.stdout.split('- A real summary').length - 1 === 1);
  suite.check('multi-paragraph summary is preserved', good.stdout.includes('  A second paragraph.'));
  suite.check('dependency bookkeeping and older versions stay out', !/Updated dependencies|An older change/.test(good.stdout));

  const missing = detail(valid, '99.99.99');
  suite.check('missing version fails', missing.status !== 0);
  suite.check('missing version reports its diagnostic on stderr', /no changelog section/.test(missing.stderr) && missing.stderr.includes('99.99.99'));
  suite.check('missing version emits no partial notes', missing.stdout === '');

  const empty = fixture(`## ${version}\n\n- Updated dependencies\n- @scope/dependency@1.2.3\n`);
  const noSummaries = detail(empty, version);
  suite.check('dependency-only section fails', noSummaries.status !== 0);
  suite.check('empty parse reports missing summaries', /no release summaries/.test(noSummaries.stderr));
  suite.check('empty parse emits no partial notes', noSummaries.stdout === '');

  const noArgs = detail(valid);
  suite.check('missing argument retains usage refusal', noArgs.status !== 0 && noArgs.stderr.includes('usage:'));
  const badBudget = detail(valid, version, '--max-bytes=0');
  suite.check('invalid budget remains an explicit failure', badBudget.status !== 0 && badBudget.stderr.includes('positive number'));
  const large = fixture(`## ${version}\n\n` + Array.from({ length: 20 }, (_, i) => `- Change ${i}: ${'x'.repeat(100)}\n`).join(''));
  const bounded = detail(large, version, '--max-bytes=512');
  suite.check('valid summaries still respect the byte budget', bounded.status === 0 && Buffer.byteLength(bounded.stdout) <= 512);
  suite.check('truncation remains explicit', bounded.stdout.includes('more changes did not fit'));

  const normal = workflow(valid);
  suite.check('valid workflow reaches the captured release call', normal.status === 0 && normal.notes !== undefined, normal.stderr);
  suite.check('valid workflow includes summary and generated notes', normal.notes?.includes('A real summary') && normal.notes?.includes('Generated PR notes'));
  suite.check('valid workflow emits no warning', !normal.stdout.includes('::warning::'));

  for (const mode of ['missing', 'read-error']) {
    const dir = fixture(mode === 'missing' ? '## 9.8.6\n\n- Old summary\n' : undefined);
    if (mode === 'read-error') mkdirSync(join(dir, 'bin/CHANGELOG.md'));
    const result = workflow(dir);
    suite.check(`${mode}: detail failure does not prevent the release call`, result.status === 0 && result.notes !== undefined, result.stderr);
    suite.check(`${mode}: workflow annotates the failure`, result.stdout.includes('::warning::'));
    suite.check(`${mode}: helper stderr remains visible`, result.stderr.length > 0);
    suite.check(`${mode}: generated notes survive without partial detail`, result.notes?.includes('Generated PR notes') && !result.notes?.includes('## Changes in this release'));
  }
  suite.check('all 25 behavioral assertions ran', suite.passed() + suite.failed() === 25);
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  suite.finish();
}
