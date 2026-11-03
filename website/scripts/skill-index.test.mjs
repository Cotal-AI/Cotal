import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const website = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = dirname(website);

// Run the real sync entry point in a private output tree. Inputs outside the skills are read-only
// links; the scripts, website sources and skills are copied so no generated file reaches the checkout.
function linkInputs(from, to, omit) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!omit.includes(entry.name)) symlinkSync(join(from, entry.name), join(to, entry.name), entry.isDirectory() ? 'dir' : 'file');
  }
}

test('skill discovery uses YAML frontmatter and preserves the served bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cotal-skill-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  linkInputs(repo, root, ['.git', '.internal', 'node_modules', 'website', 'implementations']);
  const site = join(root, 'website');
  mkdirSync(site);
  for (const name of ['scripts', 'src', 'public', 'package.json']) cpSync(join(website, name), join(site, name), { recursive: true });
  symlinkSync(join(website, 'node_modules'), join(site, 'node_modules'), 'dir');
  linkInputs(join(repo, 'implementations'), join(root, 'implementations'), ['cli']);
  linkInputs(join(repo, 'implementations/cli'), join(root, 'implementations/cli'), ['cotal-skills']);
  cpSync(join(repo, 'implementations/cli/cotal-skills'), join(root, 'implementations/cli/cotal-skills'), { recursive: true });
  const skills = join(root, 'implementations/cli/cotal-skills/skills');
  const indexPath = join(site, 'public/.well-known/agent-skills/index.json');
  const sync = () => spawnSync(process.execPath, [join(site, 'scripts/sync-docs.mjs')], { cwd: site, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const put = (name, raw) => {
    const dir = join(skills, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), raw);
  };
  const valid = [
    ['plain', 'description: A plain description.', 'A plain description.'],
    ['folded', 'description: >-\n  Coordinate peers\n  without losing context.', 'Coordinate peers without losing context.'],
    ['literal', 'description: |\n  First line.\n  Second line.', 'First line.\nSecond line.\n'],
    ['double-quoted', 'description: "Say \\"hi\\" to a peer."', 'Say "hi" to a peer.'],
    ['single-quoted', "description: 'It''s a skill.'", "It's a skill."],
    ['comment', 'description: A useful skill. # author note', 'A useful skill.'],
    ['crlf', 'description: >-\n  Windows line\n  endings.', 'Windows line endings.'],
    ['body-shadow', 'description: The frontmatter wins.', 'The frontmatter wins.'],
  ].map(([name, yaml, description]) => {
    let raw = `---\nname: probe-${name}\n${yaml}\n---\n\n# Probe\n\ndescription: The body is not metadata.\n`;
    if (name === 'crlf') raw = raw.replaceAll('\n', '\r\n');
    return { name: `probe-${name}`, raw, description };
  });
  for (const item of valid) put(item.name, item.raw);
  const built = sync();
  assert.equal(built.error, undefined);
  assert.equal(built.status, 0, built.stderr);
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const item of valid) {
    await t.test(item.name, () => {
      const row = index.skills.find(skill => skill.name === item.name);
      assert.ok(row, 'the actual sync indexed the fixture');
      assert.equal(row.description, item.description);
      assert.equal(row.digest, `sha256:${createHash('sha256').update(item.raw).digest('hex')}`);
      assert.equal(readFileSync(join(site, 'public', row.url), 'utf8'), item.raw);
    });
  }
  await t.test('shipped skills remain indexed', () => {
    const names = readdirSync(join(repo, 'implementations/cli/cotal-skills/skills'));
    for (const name of [...names, 'cotal-setup']) assert.ok(index.skills.some(skill => skill.name === name && typeof skill.description === 'string' && skill.description.trim()));
    assert.equal(index.skills.length, new Set([...names, 'cotal-setup']).size + valid.length);
  });
  const invalid = [
    ['body-only', '---\nname: probe-invalid\n---\n\ndescription: Body text must not be indexed.\n'],
    ['no-frontmatter', '# Probe\n\ndescription: Not frontmatter.\n'],
    ['unclosed', '---\nname: probe-invalid\ndescription: No closing fence.\n'],
    ['empty', '---\ndescription: ""\n---\n'],
    ['whitespace', '---\ndescription: "   "\n---\n'],
    ['number', '---\ndescription: 123\n---\n'],
    ['boolean', '---\ndescription: true\n---\n'],
    ['list', '---\ndescription: [a, b]\n---\n'],
    ['malformed', '---\ndescription: [unclosed\n---\n'],
    ['duplicate', '---\ndescription: first\ndescription: second\n---\n'],
  ];
  for (const [name, raw] of invalid) {
    await t.test(`refuses ${name}`, () => {
      put('probe-invalid', raw);
      const before = readFileSync(indexPath);
      const result = sync();
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, 'invalid metadata must fail the actual sync');
      assert.match(result.stderr, /frontmatter/);
      assert.match(result.stderr, /probe-invalid[/\\]SKILL\.md/);
      assert.deepEqual(readFileSync(indexPath), before, 'a refused skill must not replace the discovery index');
      rmSync(join(skills, 'probe-invalid'), { recursive: true });
    });
  }
});
