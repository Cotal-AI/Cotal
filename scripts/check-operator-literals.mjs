#!/usr/bin/env node
// Refuse operator-environment literals in tracked files, commit messages, and pull request text.
//
// Three classes are checked:
//   host-name    the runtime host name plus configured literal host tokens, matched whole
//   public-ipv4  a valid IPv4 literal outside special-use and documentation ranges
//   home-path    an absolute Linux home directory path
//
// Approved fixtures live in scripts/operator-literal-allowlist.json. Each exception names one
// path, one rule, and the exact number of matches that must remain. A missing fixture is an error,
// an added match is dirty, and the same token in any other path is dirty. The self-test prints a
// planted positive and a near-negative for every class before the real subject is scanned.
// Finding rows never print the matched token.
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
} from 'node:fs';
import { isIPv4 } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const RULES = new Map([
  ['host-name', 'configured host name'],
  ['public-ipv4', 'public IPv4 literal'],
  ['home-path', 'absolute home path'],
]);

const IPV4_CANDIDATE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const HOME_PATH = /(?<![A-Za-z0-9._~-])\/home\/(?!\.\.?\/?(?:$|[^A-Za-z0-9._-]))[A-Za-z0-9_][A-Za-z0-9._-]*(?=\/|$|[^A-Za-z0-9._-])/g;

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

function normalizeHostTokens(values) {
  const tokens = [];
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    if (/\r|\n/.test(value)) throw new Error('host tokens must be one line each');
    if (!tokens.some((token) => token.toLowerCase() === value.toLowerCase())) tokens.push(value);
  }
  if (tokens.length === 0) throw new Error('no host token is configured');
  return tokens;
}

function hostPatterns(hostTokens) {
  return hostTokens.map(
    (token) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(token)}(?![A-Za-z0-9_-])`, 'gi'),
  );
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
    for (const pattern of hosts) {
      pattern.lastIndex = 0;
      for (const match of lineText.matchAll(pattern)) add('host-name', lineIndex + 1, match.index + 1);
    }

    IPV4_CANDIDATE.lastIndex = 0;
    for (const match of lineText.matchAll(IPV4_CANDIDATE)) {
      if (isPublicIPv4(match[0])) add('public-ipv4', lineIndex + 1, match.index + 1);
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

function runContext(root) {
  const sha = git(['rev-parse', 'HEAD'], root).trim();
  return { sha, utc: new Date().toISOString() };
}

function emit(context, kind, fields) {
  console.log(`${kind} sha=${context.sha} utc=${context.utc} ${fields}`);
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
  let gitlinks = 0;
  for (const row of rows) {
    const { mode, path } = parseStageRow(row);
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
    const text = stat.isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath, 'utf8');
    entries.push({ path, text });
  }

  if (entries.length === 0) throw new Error('tracked-file subject has no readable files');
  return { entries, stageRows: rows.length, gitlinks };
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
  return String(text).includes('home/') ? 1 : 0;
}

const SELFTEST_HOST = ['privacy', 'fixture', 'host'].join('-');
const SELFTEST_HOME = `/${['home', 'fixture-user'].join('/')}`;
const SELFTEST_PUBLIC_IP = [8, 8, 4, 4].join('.');

const CELL_EXPECTATIONS = new Map([
  ['host-planted', 'primary=1/1 secondary=1/1'],
  ['host-substring', 'primary=0/1 secondary=1/1'],
  ['ip-planted', 'primary=1/1 secondary=1/1'],
  ['ip-loopback', 'primary=0/1 secondary=1/1'],
  ['ip-zero', 'primary=0/1 secondary=1/1'],
  ['ip-private', 'primary=0/1 secondary=1/1'],
  ['ip-documentation', 'primary=0/1 secondary=1/1'],
  ['home-planted', 'primary=1/1 secondary=1/1'],
  ['home-relative', 'primary=0/1 secondary=1/1'],
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
  // SELFTEST_CELL home-planted START
  matchCell('home-planted', `file://${SELFTEST_HOME}/file`, 'home-path', 1, homeFragmentCount, 1),
  // SELFTEST_CELL home-planted END
  // SELFTEST_CELL home-relative START
  matchCell('home-relative', `open ${SELFTEST_HOME.slice(1)}/file`, 'home-path', 0, homeFragmentCount, 1),
  // SELFTEST_CELL home-relative END
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
        `source=${JSON.stringify(finding.where)} rule=${finding.rule} occurrence=${index + 1}/${group.length}`,
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

function main(argv) {
  let args;
  let context;
  try {
    args = parseArgs(argv);
    context = runContext(args.root);
  } catch (error) {
    console.error(`operator literal check: ${error.message}`);
    return 2;
  }

  emit(context, 'IDENTITY_ROW', 'subject=operator-literal-check source=current-git-head');

  if (!selftest(context)) return 2;
  if (args.selftestOnly) return 0;

  let hostTokens;
  try {
    const configured = (process.env.COTAL_PRIVACY_HOST_TOKENS ?? '').split(/\r?\n/);
    hostTokens = normalizeHostTokens([hostname(), ...configured, ...args.hostTokens]);
  } catch (error) {
    emit(context, 'ERROR_ROW', `subject=host-configuration status=broken reason=${JSON.stringify(error.message)}`);
    return 2;
  }

  let tracked;
  let treeResult;
  try {
    tracked = trackedEntries(args.root);
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
    `subject=tree files_scanned=${tracked.entries.length}/${tracked.stageRows - tracked.gitlinks} eligible_tracked_files findings=${treeResult.findings.length}/${tracked.entries.length}_files status=${treeResult.status}`,
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
  process.exit(main(process.argv));
}
