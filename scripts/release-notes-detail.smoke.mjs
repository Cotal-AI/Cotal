import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { parse } from 'yaml';
import { firstSentence } from './release-notes-detail.mjs';
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
function workflow(dir, previous = 'v9.8.6', dependencies = true) {
  const tools = join(dir, 'tools'), temp = join(dir, 'temp'), scripts = join(dir, 'scripts');
  for (const path of [tools, temp, scripts]) mkdirSync(path);
  copyFileSync(script, join(scripts, 'release-notes-detail.mjs'));
  copyFileSync(join(root, 'scripts/main-entry.mjs'), join(scripts, 'main-entry.mjs'));
  if (dependencies) symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(tools, 'gh'), `#!/bin/sh
case "$1:$2" in
  release:view) exit 1 ;;
  release:list) printf '%s\\n' "$PREVIOUS_RELEASE" ;;
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
      GITHUB_REPOSITORY: 'fixture/repository', GITHUB_SHA: 'fixture-source', CAPTURE_FILE: captured, PREVIOUS_RELEASE: previous },
  });
  if (result.error) throw result.error;
  return { ...result, notes: existsSync(captured) ? readFileSync(captured, 'utf8') : undefined };
}

// Run the actual announcement shell against a loopback receiver. Wrappers record only whether a
// synthetic credential appeared in arguments, never the arguments or credential themselves.
async function announcement(mode = 'ok') {
  const dir = fixture();
  const tools = join(dir, 'tools'), temp = join(dir, 'temp'), receipt = join(dir, 'arguments.jsonl');
  mkdirSync(tools); mkdirSync(temp);
  const curl = spawnSync('which', ['curl'], { encoding: 'utf8' });
  if (curl.status !== 0) throw new Error('announcement regression needs curl for the original-command control');
  for (const [name, executable] of [['node', process.execPath], ['curl', curl.stdout.trim()]]) {
    writeFileSync(join(tools, name), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ARGUMENT_RECEIPT, JSON.stringify({ secret: args.some(a => a.includes(process.env.WEBHOOK_URL)) })+'\\n', { mode: 0o600 });
const result = cp.spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  }
  const requests = [];
  const server = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk);
    req.on('end', () => {
      requests.push({ method: req.method, body: body ? JSON.parse(body) : undefined });
      if (mode === 'redirect') res.writeHead(302, { Location: '/elsewhere' });
      else res.writeHead(mode === 'refused' ? 503 : 204);
      res.end();
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const webhook = mode === 'invalid-url' ? 'synthetic-invalid-webhook-credential' : `http://127.0.0.1:${server.address().port}/synthetic-webhook-credential`;
  const doc = parse(readFileSync(join(root, '.github/workflows/github-releases-to-discord.yml'), 'utf8'));
  const step = Object.values(doc.jobs).flatMap(job => job.steps).find(step => step.name === 'Post the release on Discord');
  if (!step?.run) throw new Error('announcement shell missing');
  let child, timer;
  try {
    child = spawn('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, RUNNER_TEMP: temp,
        WEBHOOK_URL: webhook, ARGUMENT_RECEIPT: receipt, TAG: 'v9.8.7', URL: 'https://example.invalid/release',
        BODY: mode === 'missing-highlights' ? 'Generated PR notes only' : '## What changed\n\n- A release headline.\n\n<details>\nSupporting prose.\n</details>\n' },
    });
    let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 20_000);
    const status = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    const commands = readFileSync(receipt, 'utf8').trim().split('\n').map(JSON.parse);
    return { status, requests, output, commands: commands.length,
      credentialArgument: commands.some(command => command.secret), credentialPrinted: output.includes(webhook) };
  } finally {
    clearTimeout(timer);
    await new Promise(done => server.close(done));
  }
}

try {
  const valid = fixture(`# Changelog\n\n## ${version}\n\n- abcdef1: A real summary\n\n  A second paragraph.\n\n- Updated dependencies\n\n## 9.8.6\n\n- An older change\n`);
  mkdirSync(join(valid, 'packages', 'copy'), { recursive: true });
  copyFileSync(join(valid, 'bin/CHANGELOG.md'), join(valid, 'packages/copy/CHANGELOG.md'));
  const good = detail(valid, version);
  suite.check('valid release succeeds', good.status === 0, good.stderr);
  const layers = good.stdout.split('<details>');
  suite.check('summary appears once in each layer across packages', layers.length === 2 && layers.every(layer => layer.split('- A real summary').length - 1 === 1));
  suite.check('a heading retains its first line rather than later prose', firstSentence('# A headline.\n\nSupporting detail.') === '# A headline.');
  suite.check('a list retains its first line rather than later prose', firstSentence('- A headline.\n\nSupporting detail.') === '- A headline.');
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
  const tiny = detail(valid, version, '--max-bytes=1');
  suite.check('an impossible budget refuses without partial output', tiny.status !== 0 && tiny.stdout === '');
  const unicode = fixture(`## ${version}\n\n` + Array.from({ length: 20 }, (_, i) => `- Change ${i}: ${'é'.repeat(70)}\n`).join(''));
  const byteBounded = detail(unicode, version, '--max-bytes=600');
  suite.check('the budget counts UTF-8 bytes rather than characters', byteBounded.status === 0 && Buffer.byteLength(byteBounded.stdout) <= 600 && byteBounded.stdout.endsWith('</details>\n'));

  const normal = workflow(valid);
  suite.check('valid workflow reaches the captured release call', normal.status === 0 && normal.notes !== undefined, normal.stderr);
  suite.check('valid workflow includes summary and generated notes', normal.notes?.includes('A real summary') && normal.notes?.includes('Generated PR notes'));
  suite.check('valid workflow emits no warning', !normal.stdout.includes('::warning::'));

  const range = fixture(`## ${version}\n\n- Current change.\n\n## 9.8.6\n\n- Previously unannounced change.\n\n## 9.8.5\n\n- Already announced change.\n`);
  const ranged = workflow(range, 'v9.8.5');
  suite.check('the actual workflow includes skipped versions and excludes the previous release', ranged.status === 0 && ranged.notes?.includes('Previously unannounced change.') && !ranged.notes?.includes('Already announced change.'));
  const release = parse(readFileSync(join(root, '.github/workflows/changesets.yml'), 'utf8'));
  const steps = release.jobs['verify-install'].steps;
  const setup = steps.findIndex(step => step.uses?.startsWith('pnpm/action-setup@'));
  const install = steps.findIndex(step => step.name === 'Install release-note dependencies');
  const cut = steps.findIndex(step => step.name === 'Cut the GitHub Release');
  suite.check('the release job installs its parser without a new publication gate', setup >= 0 && install > setup && cut > install && steps[setup]['continue-on-error'] === true && steps[install]['continue-on-error'] === true && steps[install].run.includes('--frozen-lockfile --ignore-scripts'));

  for (const mode of ['missing', 'read-error', 'missing-dependency']) {
    const dir = fixture(mode === 'missing' ? '## 9.8.6\n\n- Old summary\n' : mode === 'missing-dependency' ? `## ${version}\n\n- Valid summary.\n` : undefined);
    if (mode === 'read-error') mkdirSync(join(dir, 'bin/CHANGELOG.md'));
    const result = workflow(dir, 'v9.8.6', mode !== 'missing-dependency');
    suite.check(`${mode}: detail failure does not prevent the release call`, result.status === 0 && result.notes !== undefined, result.stderr);
    suite.check(`${mode}: workflow annotates the failure`, result.stdout.includes('::warning::'));
    suite.check(`${mode}: helper stderr remains visible`, result.stderr.length > 0);
    suite.check(`${mode}: generated notes survive without partial detail`, result.notes?.includes('Generated PR notes') && !result.notes?.includes('## What changed'));
  }
  const posted = await announcement();
  suite.check('the actual announcement workflow posts once successfully', posted.status === 0 && posted.requests.length === 1);
  suite.check('the HTTP body contains highlights, not the collapsed prose', posted.requests[0]?.method === 'POST' && posted.requests[0].body.embeds[0].description.includes('A release headline.') && !posted.requests[0].body.embeds[0].description.includes('Supporting prose.'));
  suite.check('neither announcement command receives the credential as an argument', posted.commands === 2 && !posted.credentialArgument);
  suite.check('successful announcement output contains no credential', !posted.credentialPrinted);

  const refused = await announcement('refused');
  suite.check('HTTP refusal fails the workflow with its status', refused.status !== 0 && refused.output.includes('HTTP 503'));
  suite.check('HTTP refusal is not retried', refused.requests.length === 1);
  suite.check('HTTP refusal exposes no credential in output or arguments', !refused.credentialArgument && !refused.credentialPrinted);

  const redirected = await announcement('redirect');
  suite.check('a redirect fails the announcement', redirected.status !== 0);
  suite.check('the redirect is never followed', redirected.requests.length === 1);
  suite.check('redirect errors expose no credential in output or arguments', !redirected.credentialArgument && !redirected.credentialPrinted);

  const invalid = await announcement('invalid-url');
  suite.check('an invalid URL fails without a request', invalid.status !== 0 && invalid.requests.length === 0);
  suite.check('URL parse errors expose no credential in output or arguments', !invalid.credentialArgument && !invalid.credentialPrinted);

  const noHighlights = await announcement('missing-highlights');
  suite.check('missing highlights refuse before any webhook request', noHighlights.status !== 0 && noHighlights.requests.length === 0);
  suite.check('missing highlights remain a named refusal', noHighlights.output.includes('no `## What changed` section'));
  suite.check('all 49 behavioral assertions ran', suite.passed() + suite.failed() === 49);
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  suite.finish();
}
