#!/usr/bin/env node
// Refuse operator-environment literals in tracked files, commit messages, and pull request text.
//
// Four classes are checked:
//   host-name     the runtime host name plus configured literal host tokens, matched whole
//   public-ipv4   a valid IPv4 literal outside special-use and documentation ranges
//   shared-ipv4   a host-shaped IPv4 literal in the shared address range
//   home-path     an absolute Unix home directory path
//
// Approved tracked-file fixtures live in scripts/operator-literal-allowlist.json. Each exception
// names one path, one rule, and the exact number of matches that must remain. Commit messages, commit
// identities, the PR title, and the PR body never use the allowlist because that text is editable and
// an edited PR reruns the gate. An allowlist entry naming a non-file breaks the check with exit 2, so
// measurement prose in PR text uses placeholders. The self-test prints a planted positive and a
// near-negative for every class before the real subject is scanned.
// Workflow files are excluded from host-name matching because CI configuration must name its pool.
// Shared-address and public-address network notation is excluded because it names a range, not a
// host. Finding rows never print the matched token.
//
// Usage:
//   node scripts/check-operator-literals.mjs [--range <base>..<head>] [--event <event.json>]
//     [--host-token <literal>] [--root <repo>] [--allowlist <file>]
//   node scripts/check-operator-literals.mjs --selftest
//
// Exit 0 clean, 1 literal found, 2 the check could not run or its self-test failed.

import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isIPv4 } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const RULES = new Map([
  ['host-name', 'configured host name'],
  ['public-ipv4', 'public IPv4 literal'],
  ['shared-ipv4', 'shared IPv4 literal'],
  ['home-path', 'absolute home path'],
]);

const IPV4_CANDIDATE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const CIDR_SUFFIX = /^\/(?:[0-9]|[12][0-9]|3[0-2])(?![A-Za-z0-9_/])/;
const HOME_PATH = /(?<![A-Za-z0-9._~-])\/(?:home|Users)\/(?!\.\.?\/?(?:$|[^A-Za-z0-9._-]))[A-Za-z0-9_][A-Za-z0-9._-]*(?=\/|$|[^A-Za-z0-9._-])/g;

const NON_PUBLIC_CIDRS = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
].map(([parts, bits]) => [partsToInt(parts), bits]);

const SHARED_IPV4_BASE = partsToInt([100, 64, 0, 0]);
const MIN_HOST_TOKEN_LENGTH = 7;
// A host literal should be rare, so this ceiling stops a vocabulary token before it floods the scan.
const HOST_TOKEN_FILE_CEILING = 25;

const PUBLIC_EXCEPTIONS = new Set([
  partsToInt([192, 0, 0, 9]),
  partsToInt([192, 0, 0, 10]),
]);

function partsToInt(parts) {
  return parts.reduce((value, part) => ((value * 256) + part) >>> 0, 0);
}

function ipv4ToInt(value) {
  return partsToInt(value.split('.').map(Number));
}

export function isSharedIPv4(value) {
  if (!isIPv4(value)) return false;
  const numeric = ipv4ToInt(value);
  return (numeric >>> 22) === (SHARED_IPV4_BASE >>> 22);
}

export function isPublicIPv4(value) {
  if (!isIPv4(value)) return false;
  const numeric = ipv4ToInt(value);
  if (PUBLIC_EXCEPTIONS.has(numeric)) return true;
  return !NON_PUBLIC_CIDRS.some(
    ([base, bits]) => (numeric >>> (32 - bits)) === (base >>> (32 - bits)),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hostConfigurationError(source, message) {
  const error = new Error(message);
  error.hostSource = source;
  return error;
}

function normalizeHostTokens(values, source, allowEmpty = false) {
  const tokens = [];
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    if (/\r|\n/.test(value)) {
      throw hostConfigurationError(source, 'host tokens must be one line each');
    }
    if (!tokens.some((token) => token.toLowerCase() === value.toLowerCase())) tokens.push(value);
  }
  if (!allowEmpty && tokens.length === 0) {
    throw hostConfigurationError(source, 'no host token is configured');
  }
  return tokens;
}

function hostTokenConfiguration(runtimeHostname, repositoryValues, argumentValues) {
  const machineHostTokens = normalizeHostTokens(
    [runtimeHostname],
    'machine-hostname',
  );
  const configuredHostTokens = [
    ...normalizeHostTokens(repositoryValues, 'repository-variable', true).map((token) => ({
      token,
      source: 'repository-variable',
    })),
    ...normalizeHostTokens(argumentValues, 'argument', true).map((token) => ({
      token,
      source: 'argument',
    })),
  ].filter(
    (entry, index, entries) =>
      entries.findIndex((candidate) => candidate.token.toLowerCase() === entry.token.toLowerCase()) === index,
  );
  const hostTokens = [...machineHostTokens];
  for (const entry of configuredHostTokens) {
    if (!hostTokens.some((token) => token.toLowerCase() === entry.token.toLowerCase())) {
      hostTokens.push(entry.token);
    }
  }
  return { hostTokens, machineHostTokens, configuredHostTokens };
}

function hostPatterns(hostTokens) {
  return hostTokens.map(
    (token) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(token)}(?![A-Za-z0-9_-])`, 'gi'),
  );
}

// CI configuration must name its pool, so only this rule excludes this exact subtree.
function excludesHostNames(path) {
  return String(path).startsWith('.github/workflows/');
}

const CONFIGURED_HOST_TOKEN_SOURCES = new Set(['repository-variable', 'argument']);

function assertConfiguredHostTokenSources(hostTokens, guard) {
  for (const entry of hostTokens) {
    if (!CONFIGURED_HOST_TOKEN_SOURCES.has(entry.source)) {
      throw hostConfigurationError(
        entry.source ?? 'unknown',
        `${guard} guard requires configured tokens; received source=${entry.source ?? 'unknown'}`,
      );
    }
  }
}

function hostTokenLengthFailures(hostTokens) {
  assertConfiguredHostTokenSources(hostTokens, 'length');
  return hostTokens
    .filter((entry) => entry.token.length < MIN_HOST_TOKEN_LENGTH)
    .map((entry) => ({ tokenLength: entry.token.length, source: entry.source }));
}

function hostTokenCeilingFailures(entries, hostTokens) {
  assertConfiguredHostTokenSources(hostTokens, 'ceiling');
  const failures = [];
  for (const { token, source } of hostTokens) {
    const pattern = hostPatterns([token])[0];
    let matchingFiles = 0;
    for (const entry of entries) {
      if (excludesHostNames(entry.path)) continue;
      pattern.lastIndex = 0;
      if (pattern.test(entry.text)) matchingFiles += 1;
    }
    if (matchingFiles > HOST_TOKEN_FILE_CEILING) {
      failures.push({ tokenLength: token.length, matchingFiles, source });
    }
  }
  return failures;
}

function hasBinaryPrefix(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

function lines(text) {
  return String(text ?? '').split(/\r?\n/);
}

export function findings(text, where, hostTokens) {
  const out = [];
  const seen = new Set();
  const hosts = hostPatterns(hostTokens);

  const add = (rule, line, column) => {
    const key = `${rule}:${line}:${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ where, rule, line, column });
  };

  lines(text).forEach((lineText, lineIndex) => {
    if (!excludesHostNames(where)) {
      for (const pattern of hosts) {
        pattern.lastIndex = 0;
        for (const match of lineText.matchAll(pattern)) {
          add('host-name', lineIndex + 1, match.index + 1);
        }
      }
    }

    IPV4_CANDIDATE.lastIndex = 0;
    for (const match of lineText.matchAll(IPV4_CANDIDATE)) {
      const urlHost = /:\/\/[^\s\/]*$/.test(lineText.slice(0, match.index));
      const cidrNotation =
        !urlHost && CIDR_SUFFIX.test(lineText.slice(match.index + match[0].length));
      if (isSharedIPv4(match[0]) && !cidrNotation) {
        add('shared-ipv4', lineIndex + 1, match.index + 1);
      } else if (isPublicIPv4(match[0]) && !cidrNotation) {
        add('public-ipv4', lineIndex + 1, match.index + 1);
      }
    }

    HOME_PATH.lastIndex = 0;
    for (const match of lineText.matchAll(HOME_PATH)) add('home-path', lineIndex + 1, match.index + 1);
  });

  return out;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runContext(root, writeLine = (line) => console.log(line)) {
  const sha = git(['rev-parse', 'HEAD'], root).trim();
  return { sha, utc: new Date().toISOString(), writeLine };
}

function emit(context, kind, fields) {
  context.writeLine(`${kind} sha=${context.sha} utc=${context.utc} ${fields}`);
}

function parseStageRow(row) {
  const match = /^(\d{6}) [0-9a-f]+ \d+\t([\s\S]+)$/.exec(row);
  if (!match) throw new Error('git ls-files returned an unreadable row');
  return { mode: match[1], path: match[2] };
}

export function trackedEntries(root) {
  const rows = git(['ls-files', '--stage', '-z'], root).split('\0').filter(Boolean);
  if (rows.length === 0) throw new Error('tracked-file subject is empty');

  const entries = [];
  const binarySkippedPaths = [];
  let gitlinks = 0;
  for (const row of rows) {
    const { mode, path } = parseStageRow(row);
    // Gitlinks are staged paths but not eligible files because their content is not in this tree.
    if (mode === '160000') {
      gitlinks += 1;
      continue;
    }

    const fullPath = resolve(root, path);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      throw new Error(`tracked subject is missing: ${path}`);
    }
    let text;
    if (stat.isSymbolicLink()) {
      text = readlinkSync(fullPath);
    } else {
      const contents = readFileSync(fullPath);
      if (hasBinaryPrefix(contents)) {
        binarySkippedPaths.push(path);
        continue;
      }
      text = contents.toString('utf8');
    }
    entries.push({ path, text });
  }

  if (entries.length === 0) throw new Error('tracked-file subject has no readable files');
  return {
    entries,
    stageRows: rows.length,
    gitlinks,
    binarySkipped: binarySkippedPaths.length,
    binarySkippedPaths,
  };
}

function readAllowlist(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('allowlist must be a JSON object');
  }
  return parsed;
}

function validateAllowlist(entries, allowlist) {
  const paths = new Set(entries.map((entry) => entry.path));
  const normalized = new Map();
  const errors = [];

  for (const [path, rules] of Object.entries(allowlist)) {
    if (isAbsolute(path) || path.split('/').includes('..')) {
      errors.push(`allowlist path must be repository-relative: ${path}`);
      continue;
    }
    if (!paths.has(path)) {
      errors.push(`allowlist path is not a scanned file: ${path}`);
      continue;
    }
    if (!rules || Array.isArray(rules) || typeof rules !== 'object') {
      errors.push(`allowlist entry must name rules: ${path}`);
      continue;
    }

    for (const [rule, entry] of Object.entries(rules)) {
      if (!RULES.has(rule)) {
        errors.push(`allowlist names an unknown rule: ${path} ${rule}`);
        continue;
      }
      if (
        !entry ||
        Array.isArray(entry) ||
        typeof entry !== 'object' ||
        !Number.isInteger(entry.count) ||
        entry.count < 1 ||
        typeof entry.reason !== 'string' ||
        entry.reason.trim().length === 0
      ) {
        errors.push(`allowlist rule needs a positive count and reason: ${path} ${rule}`);
        continue;
      }
      normalized.set(`${path}\0${rule}`, { path, rule, count: entry.count, reason: entry.reason });
    }
  }

  return { normalized, errors };
}

function scanEntries(entries, hostTokens, allowlist = {}) {
  if (entries.length === 0) {
    return { status: 'broken', findings: [], allowed: [], errors: ['subject has no files'] };
  }

  const all = [];
  for (const entry of entries) all.push(...findings(entry.text, entry.path, hostTokens));

  const validation = validateAllowlist(entries, allowlist);
  if (validation.errors.length > 0) {
    return { status: 'broken', findings: all, allowed: [], errors: validation.errors };
  }

  const grouped = new Map();
  for (const finding of all) {
    const key = `${finding.where}\0${finding.rule}`;
    const group = grouped.get(key) ?? [];
    group.push(finding);
    grouped.set(key, group);
  }

  const allowed = [];
  const errors = [];
  const dirtyKeys = new Set();
  for (const [key, entry] of validation.normalized) {
    const actual = grouped.get(key)?.length ?? 0;
    allowed.push({ ...entry, actual });
    if (actual < entry.count) {
      errors.push(
        `allowlisted fixture count fell below its required value: ${entry.path} ${entry.rule} ${actual}/${entry.count}`,
      );
    } else if (actual > entry.count) {
      dirtyKeys.add(key);
    }
  }

  if (errors.length > 0) return { status: 'broken', findings: all, allowed, errors };

  const remaining = all.filter((finding) => {
    const key = `${finding.where}\0${finding.rule}`;
    const entry = validation.normalized.get(key);
    if (!entry) return true;
    if (dirtyKeys.has(key)) return true;
    return false;
  });

  return {
    status: remaining.length > 0 ? 'dirty' : 'clean',
    findings: remaining,
    allowed,
    errors: [],
  };
}

const RS = '\x1e';
const US = '\x1f';

export function commitsInRange(range, root) {
  const raw = git(['log', `--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e`, range], root);
  return raw
    .split(RS)
    .map((value) => value.replace(/^\n/, ''))
    .filter((value) => value.trim().length > 0)
    .map((value) => {
      const [sha, author, committer, message] = value.split(US);
      return { sha, author, committer, message: message ?? '' };
    });
}

function scanCommits(commits, hostTokens) {
  const all = [];
  for (const commit of commits) {
    const short = commit.sha.slice(0, 9);
    all.push(...findings(commit.message, `commit ${short} message`, hostTokens));
    all.push(...findings(commit.author, `commit ${short} author`, hostTokens));
    all.push(...findings(commit.committer, `commit ${short} committer`, hostTokens));
  }
  return all;
}

function eventSubjects(eventPath) {
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (!event.pull_request) throw new Error('event subject has no pull_request');
  return [
    { path: 'PR title', text: event.pull_request.title ?? '' },
    { path: 'PR body', text: event.pull_request.body ?? '' },
  ];
}

function shapeIPv4Count(text) {
  let count = 0;
  IPV4_CANDIDATE.lastIndex = 0;
  for (const match of String(text).matchAll(IPV4_CANDIDATE)) {
    if (isIPv4(match[0])) count += 1;
  }
  return count;
}

function homeFragmentCount(text) {
  return /(?:home|Users)\//.test(String(text)) ? 1 : 0;
}

const SELFTEST_HOST = ['privacy', 'fixture', 'host'].join('-');
const SELFTEST_HOME = `/${['home', 'fixture-user'].join('/')}`;
const SELFTEST_MAC_HOME = `/${['Users', 'fixture-user'].join('/')}`;
const SELFTEST_PUBLIC_IP = [8, 8, 4, 4].join('.');
const SELFTEST_SHARED_IP = [100, 64, 23, 45].join('.');

const CELL_EXPECTATIONS = new Map([
  ['host-planted', 'primary=1/1 secondary=1/1'],
  ['host-substring', 'primary=0/1 secondary=1/1'],
  ['workflow-host-exclusion', 'workflow=0/1 non_workflow=1/1 planted=2/2'],
  ['ip-planted', 'primary=1/1 secondary=1/1'],
  ['ip-loopback', 'primary=0/1 secondary=1/1'],
  ['ip-zero', 'primary=0/1 secondary=1/1'],
  ['ip-private', 'primary=0/1 secondary=1/1'],
  ['ip-documentation', 'primary=0/1 secondary=1/1'],
  ['ip-network', 'primary=0/1 secondary=1/1'],
  ['public-cidr-alpha-tail', 'primary=1/1 zero_control=0/1 planted=1/1'],
  ['public-cidr-slash-tail', 'primary=1/1 zero_control=0/1 planted=1/1'],
  ['shared-ip-planted', 'primary=1/1 secondary=1/1'],
  ['shared-ip-private', 'primary=0/1 secondary=1/1'],
  ['shared-ip-network', 'primary=0/1 secondary=1/1'],
  ['shared-cidr-alpha-tail', 'primary=1/1 zero_control=0/1 planted=1/1'],
  ['shared-cidr-slash-tail', 'primary=1/1 zero_control=0/1 planted=1/1'],
  ['shared-ip-url-host', 'primary=1/1 secondary=1/1'],
  ['shared-ip-url-userinfo', 'primary=1/1 secondary=1/1'],
  ['shared-ip-url-path', 'primary=0/1 secondary=1/1'],
  ['home-planted', 'primary=1/1 secondary=1/1'],
  ['home-relative', 'primary=0/1 secondary=1/1'],
  ['mac-home-planted', 'primary=1/1 secondary=1/1'],
  ['mac-home-relative', 'primary=0/1 secondary=1/1'],
  ['short-host-token', `scanner=broken runtime_scanned=1/1 runtime_guard_errors=0/2 source=argument token_length=5/${MIN_HOST_TOKEN_LENGTH}_minimum configured_errors=1/1`],
  ['host-token-ceiling', `scanner=broken source=repository-variable matching_files=26/${HOST_TOKEN_FILE_CEILING}_ceiling token_length=${SELFTEST_HOST.length}/${MIN_HOST_TOKEN_LENGTH}_minimum errors=1/1`],
  ['binary-skip', 'files_scanned=1/1 binary_skipped=1/1'],
  ['production-main-wiring', 'exit=0/0 configuration_errors=0/0 machine_source_errors=0/0 skip_accounting_errors=0/0 skip_rows=1/1 unique_skip_paths=1/1 binary_skipped=1/1'],
  ['production-short-token-guard', `exit=2/2 configuration_errors=1/1 source=argument source_rows=1/1 reason_rows=1/1 token_length=5/${MIN_HOST_TOKEN_LENGTH}_minimum`],
  ['production-token-ceiling-guard', `exit=2/2 configuration_errors=1/1 source=repository-variable source_rows=1/1 reason_rows=1/1 matching_files=26/${HOST_TOKEN_FILE_CEILING}_ceiling`],
  ['allowlisted-fixture', 'scanner=clean allowed=1/1'],
  ['same-token-elsewhere', 'scanner=dirty findings=1/1'],
  ['allowlist-fixture-deleted', 'scanner=broken errors=1/1'],
  ['must-come-back-dirty', 'scanner=dirty findings=1/1'],
  ['missing-subject', 'scanner=broken missing=1/1'],
]);

const REQUIRED_CELL_IDS = [...CELL_EXPECTATIONS.keys()];

function matchCell(id, text, rule, expectedPrimary, secondaryReader, expectedSecondary) {
  return {
    id,
    measure: () => {
      const primary = findings(text, 'fixture', [SELFTEST_HOST]).filter(
        (finding) => finding.rule === rule,
      ).length;
      const secondary = secondaryReader(text);
      return {
        actual: `primary=${primary}/1 secondary=${secondary}/1`,
        pass: primary === expectedPrimary && secondary === expectedSecondary,
      };
    },
  };
}

function metricCount(result, metric) {
  if (metric === 'allowed') return result.allowed[0]?.actual ?? 0;
  return result[metric].length;
}

function scanCell(id, expectedStatus, metric, expectedCount, measure) {
  return {
    id,
    measure: () => {
      const result = measure();
      const count = metricCount(result, metric);
      return {
        actual: `scanner=${result.status} ${metric}=${count}/${expectedCount}`,
        pass: result.status === expectedStatus && count === expectedCount,
      };
    },
  };
}

function cidrBoundaryCell(id, positive, control, rule) {
  return {
    id,
    measure: () => {
      const primary = findings(positive, 'fixture', [SELFTEST_HOST]).filter(
        (finding) => finding.rule === rule,
      ).length;
      const zeroControl = findings(control, 'fixture', [SELFTEST_HOST]).filter(
        (finding) => finding.rule === rule,
      ).length;
      const planted = Number(
        positive.includes(rule === 'shared-ipv4' ? SELFTEST_SHARED_IP : SELFTEST_PUBLIC_IP),
      );
      return {
        actual: `primary=${primary}/1 zero_control=${zeroControl}/1 planted=${planted}/1`,
        pass: primary === 1 && zeroControl === 0 && planted === 1,
      };
    },
  };
}

function productionPathFixtureResult({
  argumentHostTokens = [],
  matchingFiles = 0,
  matchingToken,
  repositoryHostTokens = '',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'operator-literal-production-selftest-'));
  try {
    git(['init', '-q'], dir);
    writeFileSync(join(dir, 'fixture.txt'), 'clean fixture\n');
    writeFileSync(join(dir, 'fixture.bin'), Buffer.from([0x66, 0x69, 0x78, 0x00]));
    writeFileSync(join(dir, 'allowlist.json'), '{}\n');
    for (let index = 0; index < matchingFiles; index += 1) {
      writeFileSync(
        join(dir, `matching-${index}.txt`),
        `connect ${matchingToken} now\n`,
      );
    }
    git(['add', '--', '.'], dir);
    git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      dir,
    );

    const rows = [];
    const argv = [
      'node',
      'scripts/check-operator-literals.mjs',
      '--root',
      dir,
      '--allowlist',
      join(dir, 'allowlist.json'),
    ];
    for (const token of argumentHostTokens) argv.push('--host-token', token);
    const exitCode = main(argv, {
      runtimeHostname: 'runner',
      repositoryHostTokens,
      skipSelftest: true,
      writeLine: (line) => rows.push(line),
    });
    return { exitCode, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function binaryFixtureResult() {
  const dir = mkdtempSync(join(tmpdir(), 'operator-literal-binary-selftest-'));
  try {
    git(['init', '-q'], dir);
    writeFileSync(join(dir, 'fixture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    writeFileSync(join(dir, 'fixture.txt'), 'text fixture\n');
    git(['add', '--', 'fixture.png', 'fixture.txt'], dir);
    return trackedEntries(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function missingSubjectResult() {
  const dir = mkdtempSync(join(tmpdir(), 'operator-literal-selftest-'));
  try {
    let missing = 0;
    try {
      lstatSync(join(dir, 'missing'));
    } catch {
      missing = 1;
    }
    return { ...scanEntries([], [SELFTEST_HOST]), missing: Array(missing) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SELFTEST_ALLOWLIST = {
  'fixtures/scrubber.txt': {
    'home-path': { count: 1, reason: 'self-test fixture' },
  },
};

const SELFTEST_CELLS = [
  // SELFTEST_CELL host-planted START
  matchCell('host-planted', `connect ${SELFTEST_HOST} now`, 'host-name', 1, (text) => Number(text.includes(SELFTEST_HOST)), 1),
  // SELFTEST_CELL host-planted END
  // SELFTEST_CELL host-substring START
  matchCell('host-substring', `connect x${SELFTEST_HOST}y now`, 'host-name', 0, (text) => Number(text.includes(SELFTEST_HOST)), 1),
  // SELFTEST_CELL host-substring END
  // SELFTEST_CELL workflow-host-exclusion START
  {
    id: 'workflow-host-exclusion',
    measure: () => {
      const workflowText = `runs-on: ${SELFTEST_HOST}`;
      const nonWorkflowText = `connect ${SELFTEST_HOST} now`;
      const workflow = findings(
        workflowText,
        '.github/workflows/fixture.yml',
        [SELFTEST_HOST],
      ).filter((finding) => finding.rule === 'host-name').length;
      const nonWorkflow = findings(
        nonWorkflowText,
        'src/fixture.txt',
        [SELFTEST_HOST],
      ).filter((finding) => finding.rule === 'host-name').length;
      const planted = [workflowText, nonWorkflowText].filter((text) => text.includes(SELFTEST_HOST)).length;
      return {
        actual: `workflow=${workflow}/1 non_workflow=${nonWorkflow}/1 planted=${planted}/2`,
        pass: workflow === 0 && nonWorkflow === 1 && planted === 2,
      };
    },
  },
  // SELFTEST_CELL workflow-host-exclusion END
  // SELFTEST_CELL ip-planted START
  matchCell('ip-planted', SELFTEST_PUBLIC_IP, 'public-ipv4', 1, shapeIPv4Count, 1),
  // SELFTEST_CELL ip-planted END
  // SELFTEST_CELL ip-loopback START
  matchCell('ip-loopback', [127, 0, 0, 1].join('.'), 'public-ipv4', 0, shapeIPv4Count, 1),
  // SELFTEST_CELL ip-loopback END
  // SELFTEST_CELL ip-zero START
  matchCell('ip-zero', [0, 0, 0, 0].join('.'), 'public-ipv4', 0, shapeIPv4Count, 1),
  // SELFTEST_CELL ip-zero END
  // SELFTEST_CELL ip-private START
  matchCell('ip-private', [10, 23, 45, 67].join('.'), 'public-ipv4', 0, shapeIPv4Count, 1),
  // SELFTEST_CELL ip-private END
  // SELFTEST_CELL ip-documentation START
  matchCell('ip-documentation', [203, 0, 113, 9].join('.'), 'public-ipv4', 0, shapeIPv4Count, 1),
  // SELFTEST_CELL ip-documentation END
  // SELFTEST_CELL ip-network START
  matchCell('ip-network', `${SELFTEST_PUBLIC_IP}/8`, 'public-ipv4', 0, shapeIPv4Count, 1),
  // SELFTEST_CELL ip-network END
  // SELFTEST_CELL public-cidr-alpha-tail START
  cidrBoundaryCell(
    'public-cidr-alpha-tail',
    `${SELFTEST_PUBLIC_IP}/8suffix`,
    `${SELFTEST_PUBLIC_IP}/8 suffix`,
    'public-ipv4',
  ),
  // SELFTEST_CELL public-cidr-alpha-tail END
  // SELFTEST_CELL public-cidr-slash-tail START
  cidrBoundaryCell(
    'public-cidr-slash-tail',
    `${SELFTEST_PUBLIC_IP}/8/more`,
    `${SELFTEST_PUBLIC_IP}/8`,
    'public-ipv4',
  ),
  // SELFTEST_CELL public-cidr-slash-tail END
  // SELFTEST_CELL shared-ip-planted START
  matchCell('shared-ip-planted', SELFTEST_SHARED_IP, 'shared-ipv4', 1, shapeIPv4Count, 1),
  // SELFTEST_CELL shared-ip-planted END
  // SELFTEST_CELL shared-ip-private START
  matchCell('shared-ip-private', [10, 45, 67, 89].join('.'), 'shared-ipv4', 0, shapeIPv4Count, 1),
  // SELFTEST_CELL shared-ip-private END
  // SELFTEST_CELL shared-ip-network START
  matchCell('shared-ip-network', `${SELFTEST_SHARED_IP}/10`, 'shared-ipv4', 0, shapeIPv4Count, 1),
  // SELFTEST_CELL shared-ip-network END
  // SELFTEST_CELL shared-cidr-alpha-tail START
  cidrBoundaryCell(
    'shared-cidr-alpha-tail',
    `${SELFTEST_SHARED_IP}/10suffix`,
    `${SELFTEST_SHARED_IP}/10 suffix`,
    'shared-ipv4',
  ),
  // SELFTEST_CELL shared-cidr-alpha-tail END
  // SELFTEST_CELL shared-cidr-slash-tail START
  cidrBoundaryCell(
    'shared-cidr-slash-tail',
    `${SELFTEST_SHARED_IP}/10/more`,
    `${SELFTEST_SHARED_IP}/10`,
    'shared-ipv4',
  ),
  // SELFTEST_CELL shared-cidr-slash-tail END
  // SELFTEST_CELL shared-ip-url-host START
  matchCell('shared-ip-url-host', `http://${SELFTEST_SHARED_IP}/8`, 'shared-ipv4', 1, shapeIPv4Count, 1),
  // SELFTEST_CELL shared-ip-url-host END
  // SELFTEST_CELL shared-ip-url-userinfo START
  matchCell('shared-ip-url-userinfo', `http://user@${SELFTEST_SHARED_IP}/8`, 'shared-ipv4', 1, shapeIPv4Count, 1),
  // SELFTEST_CELL shared-ip-url-userinfo END
  // SELFTEST_CELL shared-ip-url-path START
  matchCell('shared-ip-url-path', `http://example.test/${SELFTEST_SHARED_IP}/10`, 'shared-ipv4', 0, shapeIPv4Count, 1),
  // SELFTEST_CELL shared-ip-url-path END
  // SELFTEST_CELL home-planted START
  matchCell('home-planted', `file://${SELFTEST_HOME}/file`, 'home-path', 1, homeFragmentCount, 1),
  // SELFTEST_CELL home-planted END
  // SELFTEST_CELL home-relative START
  matchCell('home-relative', `open ${SELFTEST_HOME.slice(1)}/file`, 'home-path', 0, homeFragmentCount, 1),
  // SELFTEST_CELL home-relative END
  // SELFTEST_CELL mac-home-planted START
  matchCell('mac-home-planted', `file://${SELFTEST_MAC_HOME}/file`, 'home-path', 1, homeFragmentCount, 1),
  // SELFTEST_CELL mac-home-planted END
  // SELFTEST_CELL mac-home-relative START
  matchCell('mac-home-relative', `open ${SELFTEST_MAC_HOME.slice(1)}/file`, 'home-path', 0, homeFragmentCount, 1),
  // SELFTEST_CELL mac-home-relative END
  // SELFTEST_CELL short-host-token START
  {
    id: 'short-host-token',
    measure: () => {
      const runtimeHostname = 'runner';
      const runtimeOnly = hostTokenConfiguration(runtimeHostname, [], []);
      const configured = hostTokenConfiguration(runtimeHostname, [], ['short']);
      const runtimeScanned = findings(
        `connect ${runtimeHostname} now`,
        'fixture',
        runtimeOnly.hostTokens,
      ).filter((finding) => finding.rule === 'host-name').length;
      const entries = Array.from({ length: HOST_TOKEN_FILE_CEILING + 1 }, (_, index) => ({
        path: `fixtures/runtime-${index}.txt`,
        text: `connect ${runtimeHostname} now`,
      }));
      const runtimeLengthErrors = hostTokenLengthFailures(runtimeOnly.configuredHostTokens);
      const runtimeCeilingErrors = hostTokenCeilingFailures(
        entries,
        runtimeOnly.configuredHostTokens,
      );
      const failures = hostTokenLengthFailures(configured.configuredHostTokens);
      const failure = failures[0];
      const runtimeGuardErrors = runtimeLengthErrors.length + runtimeCeilingErrors.length;
      return {
        actual: `scanner=${failures.length === 1 ? 'broken' : 'clean'} runtime_scanned=${runtimeScanned}/1 runtime_guard_errors=${runtimeGuardErrors}/2 source=${failure?.source ?? 'missing'} token_length=${failure?.tokenLength ?? 0}/${MIN_HOST_TOKEN_LENGTH}_minimum configured_errors=${failures.length}/1`,
        pass:
          runtimeScanned === 1 &&
          runtimeGuardErrors === 0 &&
          failures.length === 1 &&
          failure.tokenLength === 5 &&
          failure.source === 'argument',
      };
    },
  },
  // SELFTEST_CELL short-host-token END
  // SELFTEST_CELL host-token-ceiling START
  {
    id: 'host-token-ceiling',
    measure: () => {
      const entries = Array.from({ length: HOST_TOKEN_FILE_CEILING + 1 }, (_, index) => ({
        path: `fixtures/host-${index}.txt`,
        text: `connect ${SELFTEST_HOST} now`,
      }));
      const failures = hostTokenCeilingFailures(entries, [
        { token: SELFTEST_HOST, source: 'repository-variable' },
      ]);
      const failure = failures[0];
      return {
        actual: `scanner=${failures.length === 1 ? 'broken' : 'clean'} source=${failure?.source ?? 'missing'} matching_files=${failure?.matchingFiles ?? 0}/${HOST_TOKEN_FILE_CEILING}_ceiling token_length=${failure?.tokenLength ?? 0}/${MIN_HOST_TOKEN_LENGTH}_minimum errors=${failures.length}/1`,
        pass: failures.length === 1 && failure.matchingFiles === HOST_TOKEN_FILE_CEILING + 1 && failure.tokenLength === SELFTEST_HOST.length && failure.source === 'repository-variable',
      };
    },
  },
  // SELFTEST_CELL host-token-ceiling END
  // SELFTEST_CELL binary-skip START
  {
    id: 'binary-skip',
    measure: () => {
      const tracked = binaryFixtureResult();
      return {
        actual: `files_scanned=${tracked.entries.length}/1 binary_skipped=${tracked.binarySkipped}/1`,
        pass: tracked.entries.length === 1 && tracked.binarySkipped === 1,
      };
    },
  },
  // SELFTEST_CELL binary-skip END
  // SELFTEST_CELL production-main-wiring START
  {
    id: 'production-main-wiring',
    measure: () => {
      const result = productionPathFixtureResult();
      const configurationErrors = result.rows.filter(
        (row) => row.startsWith('ERROR_ROW ') && row.includes('subject=host-configuration'),
      );
      const machineSourceErrors = configurationErrors.filter(
        (row) =>
          row.includes('source=machine-hostname status=broken') &&
          row.includes('received source=machine-hostname'),
      ).length;
      const skipAccountingErrors = result.rows.filter(
        (row) =>
          row.startsWith('ERROR_ROW ') &&
          row.includes('subject=tree status=broken') &&
          row.includes('binary skip reporting mismatch'),
      ).length;
      const skipRows = result.rows.filter((row) => row.startsWith('SKIP_ROW '));
      const skipPaths = new Set(
        skipRows.map((row) => / path=(.+) reason=nul-byte$/.exec(row)?.[1]).filter(Boolean),
      );
      const scanRow = result.rows.find(
        (row) => row.startsWith('SCAN_ROW ') && row.includes('subject=tree '),
      );
      const binarySkipped = Number(/ binary_skipped=(\d+)\//.exec(scanRow ?? '')?.[1] ?? 0);
      return {
        actual: `exit=${result.exitCode}/0 configuration_errors=${configurationErrors.length}/0 machine_source_errors=${machineSourceErrors}/0 skip_accounting_errors=${skipAccountingErrors}/0 skip_rows=${skipRows.length}/1 unique_skip_paths=${skipPaths.size}/1 binary_skipped=${binarySkipped}/1`,
        pass:
          result.exitCode === 0 &&
          configurationErrors.length === 0 &&
          machineSourceErrors === 0 &&
          skipAccountingErrors === 0 &&
          skipRows.length === 1 &&
          skipPaths.size === 1 &&
          binarySkipped === 1,
      };
    },
  },
  // SELFTEST_CELL production-main-wiring END
  // SELFTEST_CELL production-short-token-guard START
  {
    id: 'production-short-token-guard',
    measure: () => {
      const result = productionPathFixtureResult({ argumentHostTokens: ['short'] });
      const errors = result.rows.filter(
        (row) => row.startsWith('ERROR_ROW ') && row.includes('subject=host-configuration'),
      );
      const sourceRows = errors.filter(
        (row) => row.includes('source=argument status=broken'),
      ).length;
      const reasonRows = errors.filter(
        (row) => row.includes('reason="host token is shorter than minimum"'),
      ).length;
      const tokenLength = Number(/ token_length=(\d+)\//.exec(errors[0] ?? '')?.[1] ?? 0);
      return {
        actual: `exit=${result.exitCode}/2 configuration_errors=${errors.length}/1 source=argument source_rows=${sourceRows}/1 reason_rows=${reasonRows}/1 token_length=${tokenLength}/${MIN_HOST_TOKEN_LENGTH}_minimum`,
        pass:
          result.exitCode === 2 &&
          errors.length === 1 &&
          sourceRows === 1 &&
          reasonRows === 1 &&
          tokenLength === 5,
      };
    },
  },
  // SELFTEST_CELL production-short-token-guard END
  // SELFTEST_CELL production-token-ceiling-guard START
  {
    id: 'production-token-ceiling-guard',
    measure: () => {
      const result = productionPathFixtureResult({
        matchingFiles: HOST_TOKEN_FILE_CEILING + 1,
        matchingToken: SELFTEST_HOST,
        repositoryHostTokens: SELFTEST_HOST,
      });
      const errors = result.rows.filter(
        (row) => row.startsWith('ERROR_ROW ') && row.includes('subject=host-configuration'),
      );
      const sourceRows = errors.filter(
        (row) => row.includes('source=repository-variable status=broken'),
      ).length;
      const reasonRows = errors.filter(
        (row) => row.includes('reason="host token matches too many files"'),
      ).length;
      const matchingFileCount = Number(
        / matching_files=(\d+)\//.exec(errors[0] ?? '')?.[1] ?? 0,
      );
      return {
        actual: `exit=${result.exitCode}/2 configuration_errors=${errors.length}/1 source=repository-variable source_rows=${sourceRows}/1 reason_rows=${reasonRows}/1 matching_files=${matchingFileCount}/${HOST_TOKEN_FILE_CEILING}_ceiling`,
        pass:
          result.exitCode === 2 &&
          errors.length === 1 &&
          sourceRows === 1 &&
          reasonRows === 1 &&
          matchingFileCount === HOST_TOKEN_FILE_CEILING + 1,
      };
    },
  },
  // SELFTEST_CELL production-token-ceiling-guard END
  // SELFTEST_CELL allowlisted-fixture START
  scanCell('allowlisted-fixture', 'clean', 'allowed', 1, () => scanEntries([{ path: 'fixtures/scrubber.txt', text: SELFTEST_HOME }], [SELFTEST_HOST], SELFTEST_ALLOWLIST)),
  // SELFTEST_CELL allowlisted-fixture END
  // SELFTEST_CELL same-token-elsewhere START
  scanCell('same-token-elsewhere', 'dirty', 'findings', 1, () => scanEntries([{ path: 'fixtures/scrubber.txt', text: SELFTEST_HOME }, { path: 'src/output.txt', text: SELFTEST_HOME }], [SELFTEST_HOST], SELFTEST_ALLOWLIST)),
  // SELFTEST_CELL same-token-elsewhere END
  // SELFTEST_CELL allowlist-fixture-deleted START
  scanCell('allowlist-fixture-deleted', 'broken', 'errors', 1, () => scanEntries([{ path: 'fixtures/scrubber.txt', text: 'fixture removed' }], [SELFTEST_HOST], SELFTEST_ALLOWLIST)),
  // SELFTEST_CELL allowlist-fixture-deleted END
  // SELFTEST_CELL must-come-back-dirty START
  scanCell('must-come-back-dirty', 'dirty', 'findings', 1, () => scanEntries([{ path: 'src/must-fail.txt', text: SELFTEST_PUBLIC_IP }], [SELFTEST_HOST])),
  // SELFTEST_CELL must-come-back-dirty END
  // SELFTEST_CELL missing-subject START
  scanCell('missing-subject', 'broken', 'missing', 1, missingSubjectResult),
  // SELFTEST_CELL missing-subject END
];

export function selftest(context) {
  let failed = 0;
  const counts = new Map();
  const passingIds = new Set();

  for (const [id, expected] of CELL_EXPECTATIONS) {
    emit(context, 'SELFTEST_EXPECTATION_ROW', `cell=${id} ${expected}`);
  }

  for (const cell of SELFTEST_CELLS) counts.set(cell.id, (counts.get(cell.id) ?? 0) + 1);
  for (const id of REQUIRED_CELL_IDS) {
    const count = counts.get(id) ?? 0;
    if (count !== 1) {
      emit(
        context,
        'SELFTEST_RESULT_ROW',
        `cell=${id} presence=${count}/1 status=FAIL reason=required-cell-count`,
      );
      failed += 1;
    }
  }

  for (const cell of SELFTEST_CELLS) {
    let measured;
    try {
      measured = cell.measure();
    } catch {
      measured = { actual: 'measurement=threw', pass: false };
    }
    emit(
      context,
      'SELFTEST_RESULT_ROW',
      `cell=${cell.id} ${measured.actual} status=${measured.pass ? 'PASS' : 'FAIL'}`,
    );
    if (measured.pass) passingIds.add(cell.id);
    else failed += 1;
  }

  const passed = REQUIRED_CELL_IDS.filter(
    (id) => counts.get(id) === 1 && passingIds.has(id),
  ).length;
  emit(
    context,
    'SELFTEST_SUMMARY_ROW',
    `cells=${passed}/${REQUIRED_CELL_IDS.length} status=${failed === 0 ? 'PASS' : 'FAIL'}`,
  );
  return failed === 0;
}

function emitBinarySkipRows(context, tracked) {
  let emitted = 0;
  const uniquePaths = new Set(tracked.binarySkippedPaths);
  for (const path of tracked.binarySkippedPaths) {
    emit(context, 'SKIP_ROW', `path=${JSON.stringify(path)} reason=nul-byte`);
    emitted += 1;
  }
  if (emitted !== tracked.binarySkipped || uniquePaths.size !== tracked.binarySkipped) {
    throw new Error(
      `binary skip reporting mismatch: emitted=${emitted}/${tracked.binarySkipped} unique=${uniquePaths.size}/${tracked.binarySkipped}`,
    );
  }
}

function treeAccountingFields(tracked) {
  const trackedFiles = tracked.stageRows - tracked.gitlinks;
  const eligibleFiles = trackedFiles - tracked.binarySkipped;
  return `stage_paths=${tracked.stageRows}/${tracked.stageRows} gitlinks=${tracked.gitlinks}/${tracked.stageRows} binary_skipped=${tracked.binarySkipped}/${trackedFiles} files_scanned=${tracked.entries.length}/${eligibleFiles}`;
}

function reportFindings(context, all) {
  const groups = new Map();
  for (const finding of all) {
    const key = `${finding.where}\0${finding.rule}`;
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.forEach((finding, index) => {
      emit(
        context,
        'FINDING_ROW',
        `source=${JSON.stringify(finding.where)} rule=${finding.rule} line=${finding.line} column=${finding.column} occurrence=${index + 1}/${group.length}`,
      );
    });
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    root: process.cwd(),
    allowlist: undefined,
    event: undefined,
    range: undefined,
    hostTokens: [],
    selftestOnly: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--selftest') {
      parsed.selftestOnly = true;
      continue;
    }
    if (['--root', '--allowlist', '--event', '--range', '--host-token'].includes(arg)) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      index += 1;
      if (arg === '--host-token') parsed.hostTokens.push(value);
      else parsed[arg.slice(2)] = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  parsed.root = resolve(parsed.root);
  parsed.allowlist = resolve(
    parsed.root,
    parsed.allowlist ?? 'scripts/operator-literal-allowlist.json',
  );
  if (parsed.event) parsed.event = resolve(parsed.event);
  return parsed;
}

function main(argv, runtime = {}) {
  let args;
  let context;
  try {
    args = parseArgs(argv);
    context = runContext(args.root, runtime.writeLine);
  } catch (error) {
    console.error(`operator literal check: ${error.message}`);
    return 2;
  }

  let hostConfiguration;
  try {
    const configured = (
      runtime.repositoryHostTokens ?? process.env.COTAL_PRIVACY_HOST_TOKENS ?? ''
    ).split(/\r?\n/);
    hostConfiguration = hostTokenConfiguration(
      runtime.runtimeHostname ?? hostname(),
      configured,
      args.hostTokens,
    );
  } catch (error) {
    emit(
      context,
      'ERROR_ROW',
      `subject=host-configuration source=${error.hostSource ?? 'unknown'} status=broken reason=${JSON.stringify(error.message)}`,
    );
    return 2;
  }
  const { configuredHostTokens, hostTokens, machineHostTokens } = hostConfiguration;

  emit(
    context,
    'IDENTITY_ROW',
    `subject=operator-literal-check source=current-git-head host_tokens=${hostTokens.length} machine_host_tokens=${machineHostTokens.length} configured_host_tokens=${configuredHostTokens.length}`,
  );

  if (!runtime.skipSelftest && !selftest(context)) return 2;
  if (args.selftestOnly) return 0;

  let lengthFailures;
  try {
    lengthFailures = hostTokenLengthFailures(configuredHostTokens);
  } catch (error) {
    emit(
      context,
      'ERROR_ROW',
      `subject=host-configuration source=${error.hostSource ?? 'unknown'} status=broken reason=${JSON.stringify(error.message)}`,
    );
    return 2;
  }
  if (lengthFailures.length > 0) {
    for (const failure of lengthFailures) {
      emit(
        context,
        'ERROR_ROW',
        `subject=host-configuration source=${failure.source} status=broken reason="host token is shorter than minimum" host_tokens=${hostTokens.length} token_length=${failure.tokenLength}/${MIN_HOST_TOKEN_LENGTH}_minimum`,
      );
    }
    return 2;
  }

  let tracked;
  try {
    tracked = trackedEntries(args.root);
    emitBinarySkipRows(context, tracked);
  } catch (error) {
    emit(context, 'ERROR_ROW', `subject=tree status=broken reason=${JSON.stringify(error.message)}`);
    return 2;
  }

  let ceilingFailures;
  try {
    ceilingFailures = hostTokenCeilingFailures(tracked.entries, configuredHostTokens);
  } catch (error) {
    emit(
      context,
      'ERROR_ROW',
      `subject=host-configuration source=${error.hostSource ?? 'unknown'} status=broken reason=${JSON.stringify(error.message)}`,
    );
    emit(
      context,
      'SCAN_ROW',
      `subject=tree ${treeAccountingFields(tracked)} findings=0/${tracked.entries.length}_files status=broken`,
    );
    return 2;
  }

  if (ceilingFailures.length > 0) {
    for (const failure of ceilingFailures) {
      emit(
        context,
        'ERROR_ROW',
        `subject=host-configuration source=${failure.source} status=broken reason="host token matches too many files" host_tokens=${hostTokens.length} token_length=${failure.tokenLength}/${MIN_HOST_TOKEN_LENGTH}_minimum matching_files=${failure.matchingFiles}/${HOST_TOKEN_FILE_CEILING}_ceiling`,
      );
    }
    emit(
      context,
      'SCAN_ROW',
      `subject=tree ${treeAccountingFields(tracked)} findings=0/${tracked.entries.length}_files status=broken`,
    );
    return 2;
  }

  let treeResult;
  try {
    treeResult = scanEntries(tracked.entries, hostTokens, readAllowlist(args.allowlist));
  } catch (error) {
    emit(context, 'ERROR_ROW', `subject=tree status=broken reason=${JSON.stringify(error.message)}`);
    return 2;
  }

  for (const entry of treeResult.allowed) {
    emit(
      context,
      'ALLOWLIST_ROW',
      `path=${JSON.stringify(entry.path)} rule=${entry.rule} matches=${entry.actual}/${entry.count} status=${entry.actual === entry.count ? 'PASS' : 'FAIL'} reason=${JSON.stringify(entry.reason)}`,
    );
  }
  for (const error of treeResult.errors) {
    emit(context, 'ERROR_ROW', `subject=allowlist status=broken reason=${JSON.stringify(error)}`);
  }
  emit(
    context,
    'SCAN_ROW',
    `subject=tree ${treeAccountingFields(tracked)} findings=${treeResult.findings.length}/${tracked.entries.length}_files status=${treeResult.status}`,
  );

  const allFindings = [...treeResult.findings];
  let broken = treeResult.status === 'broken';

  if (args.range) {
    try {
      const commits = commitsInRange(args.range, args.root);
      if (commits.length === 0) throw new Error('commit range is empty');
      const commitFindings = scanCommits(commits, hostTokens);
      allFindings.push(...commitFindings);
      emit(
        context,
        'SCAN_ROW',
        `subject=commits commits_scanned=${commits.length}/${commits.length} range_commits findings=${commitFindings.length}/${commits.length}_commits status=${commitFindings.length > 0 ? 'dirty' : 'clean'}`,
      );
    } catch (error) {
      emit(context, 'ERROR_ROW', `subject=commits status=broken reason=${JSON.stringify(error.message)}`);
      broken = true;
    }
  }

  if (args.event) {
    try {
      const subjects = eventSubjects(args.event);
      const eventFindings = scanEntries(subjects, hostTokens).findings;
      allFindings.push(...eventFindings);
      emit(
        context,
        'SCAN_ROW',
        `subject=pull-request fields_scanned=${subjects.length}/${subjects.length} event_fields findings=${eventFindings.length}/${subjects.length}_fields status=${eventFindings.length > 0 ? 'dirty' : 'clean'}`,
      );
    } catch (error) {
      emit(context, 'ERROR_ROW', `subject=pull-request status=broken reason=${JSON.stringify(error.message)}`);
      broken = true;
    }
  }

  reportFindings(context, allFindings);
  emit(
    context,
    'CHECK_SUMMARY_ROW',
    `findings=${allFindings.length}/${tracked.entries.length}_files status=${broken ? 'broken' : allFindings.length > 0 ? 'dirty' : 'clean'}`,
  );

  if (broken) return 2;
  return allFindings.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv);
}
