#!/usr/bin/env node
// Refuse operator-environment literals in tracked files, commit messages, and pull request text.
//
// Five classes are checked:
//   host-name     the runtime host name plus configured literal host tokens, matched whole
//   public-ipv4   a valid IPv4 literal outside special-use and documentation ranges
//   shared-ipv4   a host-shaped IPv4 literal in the shared address range
//   public-ipv6   a valid IPv6 literal in global unicast space outside special-use ranges
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
// An IPv6 literal is a finding only inside global unicast space, which leaves most of the
// special-use registry silent without a separate exclusion list, and the exclusion table below
// names the four ranges that do fall inside it and must not be reported. That is a reduction of
// the second list, not a removal of it: a special-use range marked globally reachable can sit
// inside global unicast and still be reported. 2620:4f:8000::/48, the direct delegation AS112
// service, is such a range and is deliberately reported, because it is a reachable address and a
// committed literal pointing at it is as much an operator detail as any other reachable host.
// An IPv4-mapped address such as the embedded form sits outside global unicast space, so it is
// classified by the IPv4 rules and never by public-ipv6. That keeps one address to one class.
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
import { isIPv4, isIPv6 } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const RULES = new Map([
  ['host-name', 'configured host name'],
  ['public-ipv4', 'public IPv4 literal'],
  ['shared-ipv4', 'shared IPv4 literal'],
  ['public-ipv6', 'public IPv6 literal'],
  ['home-path', 'absolute home path'],
]);

const IPV4_CANDIDATE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d)(?!\.[\dA-Za-z])(?!\.(?!["'`)\]}!?;]*(?:\s|$)))/g;
const CIDR_SUFFIX = /^\/(?:[0-9]|[12][0-9]|3[0-2])(?![A-Za-z0-9_/])/;
// A colon run wide enough to hold any IPv6 spelling. node:net decides whether it is an address.
// The leading guard excludes a letter, a colon and a dot, so a hostname or longer colon run is not
// cut into from the left. The trailing guards refuse digits and dotted labels while preserving a
// zero-dot letter-adjacent address as a privacy finding. A trailing sentence period is admitted before
// punctuation and then whitespace or end of line. A hyphen is NOT excluded, because a diff minus
// line and a hyphenated identifier are ordinary ways for an operator address to reach this gate,
// and the IPv4 guard admits them too.
const IPV6_CANDIDATE = /(?<![0-9A-Za-z:.])(?:[0-9A-Fa-f]{0,4}:){2,8}[0-9A-Fa-f]{0,4}(?:\.\d{1,3}){0,3}(?![0-9:])(?!\.[0-9A-Za-z])(?!\.(?!["'`)\]}!?;]*(?:\s|$)))/g;
const IPV6_CIDR_SUFFIX = /^\/(?:12[0-8]|1[01][0-9]|[1-9][0-9]|[0-9])(?![A-Za-z0-9_/])/;
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
// RFC 4291 global unicast. Every other IPv6 block is an allocation, not an operator address.
const GLOBAL_UNICAST_IPV6 = [[0x2000, 0, 0, 0, 0, 0, 0, 0], 3];
// The RFC 6890 and RFC 9637 assignments that fall inside global unicast space.
const NON_PUBLIC_IPV6_CIDRS = [
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 23],
  [[0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32],
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16],
  [[0x3fff, 0, 0, 0, 0, 0, 0, 0], 20],
];
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

// Both spellings of one address expand to the same eight hextets, so both classify the same way.
function ipv6ToHextets(value) {
  let text = value;
  const embedded = /\d{1,3}(?:\.\d{1,3}){3}$/.exec(text);
  if (embedded) {
    const octets = embedded[0].split('.').map(Number);
    const high = ((octets[0] * 256) + octets[1]).toString(16);
    const low = ((octets[2] * 256) + octets[3]).toString(16);
    text = `${text.slice(0, embedded.index)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1) return head.length === 8 ? head.map((part) => parseInt(part, 16)) : undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return undefined;
  return [...head, ...Array(fill).fill('0'), ...tail].map((part) => parseInt(part, 16));
}

function inIPv6Prefix(hextets, prefix, bits) {
  for (let index = 0; index * 16 < bits; index += 1) {
    const remaining = bits - (index * 16);
    const mask = remaining >= 16 ? 0xffff : (0xffff << (16 - remaining)) & 0xffff;
    if ((hextets[index] & mask) !== (prefix[index] & mask)) return false;
  }
  return true;
}

// A candidate can absorb a delimiting colon, as in a remote copy target where the address is
// followed by a colon and a path. One trailing colon is dropped so the address behind it is
// classified, which is what the IPv4 class already does for the same spelling. A token ending in
// a compressed run keeps both colons, since there the second colon is part of the address.
function ipv6CandidateBody(token) {
  if (token.endsWith('::') || !token.endsWith(':')) return token;
  return token.slice(0, -1);
}

// An IPv4 address embedded in an IPv6 literal belongs to the IPv4 class, and it has two spellings.
// The dotted tail is read by the IPv4 candidate pattern directly. The hex spelling of the same
// address is not, so it is recovered here: the last two hextets of a mapped, compatible or
// translation form are rebuilt as dotted quads and classified as IPv4. Without this the hex
// spelling falls in no class at all, because it is outside global unicast as well.
const IPV6_EMBEDDED_IPV4_PREFIXES = [
  [[0, 0, 0, 0, 0, 0xffff, 0, 0], 96],
  [[0, 0, 0, 0, 0, 0, 0, 0], 96],
  [[0x0064, 0xff9b, 0, 0, 0, 0, 0, 0], 96],
];

function embeddedIPv4Of(value) {
  if (!isIPv6(value)) return undefined;
  const hextets = ipv6ToHextets(value);
  if (!hextets) return undefined;
  if (!IPV6_EMBEDDED_IPV4_PREFIXES.some(([prefix, bits]) => inIPv6Prefix(hextets, prefix, bits))) {
    return undefined;
  }
  const high = hextets[6];
  const low = hextets[7];
  if (high === 0 && low === 0) return undefined;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isPublicIPv6(value) {
  if (!isIPv6(value)) return false;
  const hextets = ipv6ToHextets(value);
  if (!hextets) return false;
  if (!inIPv6Prefix(hextets, GLOBAL_UNICAST_IPV6[0], GLOBAL_UNICAST_IPV6[1])) return false;
  return !NON_PUBLIC_IPV6_CIDRS.some(([prefix, bits]) => inIPv6Prefix(hextets, prefix, bits));
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

    IPV6_CANDIDATE.lastIndex = 0;
    for (const match of lineText.matchAll(IPV6_CANDIDATE)) {
      const body = ipv6CandidateBody(match[0]);
      const cidrNotation = IPV6_CIDR_SUFFIX.test(lineText.slice(match.index + body.length));
      const embedded = embeddedIPv4Of(body);
      if (embedded) {
        // The dotted tail is already matched by the IPv4 candidate pattern on this same line, so
        // emitting here too would count one address twice. Only the hex spelling needs recovering.
        const dottedAlready = /\d{1,3}(?:\.\d{1,3}){3}$/.test(body);
        if (!dottedAlready && !cidrNotation && isSharedIPv4(embedded)) {
          add('shared-ipv4', lineIndex + 1, match.index + 1);
        } else if (!dottedAlready && !cidrNotation && isPublicIPv4(embedded)) {
          add('public-ipv4', lineIndex + 1, match.index + 1);
        }
      } else if (!cidrNotation && isPublicIPv6(body)) {
        add('public-ipv6', lineIndex + 1, match.index + 1);
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

function shapeIPv6Count(text) {
  let count = 0;
  IPV6_CANDIDATE.lastIndex = 0;
  for (const match of String(text).matchAll(IPV6_CANDIDATE)) {
    if (isIPv6(ipv6CandidateBody(match[0]))) count += 1;
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
// Assembled from parts so this file never carries an operator-shaped literal of its own.
const SELFTEST_PUBLIC_IPV6 = ['2a01', '4f8', '1c17', 'd00d', '', '1'].join(':');
const SELFTEST_PUBLIC_IPV6_EXPANDED = ['2a01', '04f8', '1c17', 'd00d', '0000', '0000', '0000', '0001'].join(':');
const SELFTEST_PUBLIC_IPV6_PREFIX = ['2a01', '4f8', '1c17', 'd00d', '', ''].join(':');
const SELFTEST_DOC_IPV6 = ['2001', 'db8', '', '1'].join(':');
const SELFTEST_DOC_IPV6_PREFIX = ['2001', 'db8', '', ''].join(':');
const SELFTEST_TEREDO_IPV6 = ['2001', '0', '', '1'].join(':');
const SELFTEST_6TO4_IPV6 = ['2002', 'c000', '204', '', '1'].join(':');
const SELFTEST_DOC2_IPV6 = ['3fff', '0', '', '1'].join(':');
const SELFTEST_AS112_IPV6 = ['2620', '4f', '8000', '', '1'].join(':');
const SELFTEST_IPV6_SCP = `scp user@${['2a01', '4f8', '1c17', 'd00d', '', '1'].join(':')}:/srv/data`;
const SELFTEST_IPV6_TRAILING_RUN = ['2a01', '4f8', '1c17', 'd00d', '', ''].join(':');
// Boundary fixtures. Each sits one step either side of a prefix edge, so an off-by-one in the
// prefix arithmetic moves the edge across it and a cell says so by name.
const SELFTEST_IPV6_TRAILING_ZERO_RUN = ['2a01', '4f8', '1c17', 'd00d', '1', '2', '3', '', ''].join(':');
const SELFTEST_IPV6_GU_FIRST = ['2000', '', '1'].join(':');
const SELFTEST_IPV6_GU_BELOW = ['1fff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff'].join(':');
const SELFTEST_IPV6_GU_ABOVE = ['4000', '', '1'].join(':');
const SELFTEST_IPV6_GU_HALF = ['3000', '', '1'].join(':');
const SELFTEST_IPV6_AFTER_2001_23 = ['2001', '200', '', '1'].join(':');
const SELFTEST_IPV6_INSIDE_2001_23 = ['2001', '100', '', '1'].join(':');
const SELFTEST_IPV6_AFTER_3FFF_20 = ['3fff', '1000', '', '1'].join(':');
const SELFTEST_IPV6_NEAR_DB8 = ['2001', 'db0', '', '1'].join(':');
const SELFTEST_IPV6_HEX_MAPPED = `::ffff:${((8 * 256) + 8).toString(16)}:${((4 * 256) + 4).toString(16)}`;
const SELFTEST_IPV6_HEX_MAPPED_DOTTED = `::ffff:${[8, 8, 4, 4].join('.')}`;
const SELFTEST_IPV6_DIFF_LINE = `-${['2a01', '4f8', '1c17', 'd00d', '', '1'].join(':')}`;
const SELFTEST_SENTENCE_IPV6_ADDRESS = ['2a01', '4f8', '1c17', 'd00d', '', '1'].join(':');
const SELFTEST_SENTENCE_IPV6 = [
  `The broker is "${SELFTEST_SENTENCE_IPV6_ADDRESS}."`,
  `The broker is '${SELFTEST_SENTENCE_IPV6_ADDRESS}.'`,
  `The broker is (${SELFTEST_SENTENCE_IPV6_ADDRESS}.)`,
  `The broker is [${SELFTEST_SENTENCE_IPV6_ADDRESS}.]`,
  `The broker is {${SELFTEST_SENTENCE_IPV6_ADDRESS}.}`,
  `Use \`${SELFTEST_SENTENCE_IPV6_ADDRESS}.\``,
  `The broker is ${SELFTEST_SENTENCE_IPV6_ADDRESS}.!`,
  `The broker is ${SELFTEST_SENTENCE_IPV6_ADDRESS}.?`,
  `The broker is ${SELFTEST_SENTENCE_IPV6_ADDRESS}.;`,
  `The broker is ["${SELFTEST_SENTENCE_IPV6_ADDRESS}."]`,
];
const SELFTEST_SENTENCE_IPV4_ADDRESS = [95, 217, 134, 22].join('.');
const SELFTEST_SENTENCE_IPV4 = [
  `The broker is "${SELFTEST_SENTENCE_IPV4_ADDRESS}."`,
  `The broker is '${SELFTEST_SENTENCE_IPV4_ADDRESS}.'`,
  `The broker is (${SELFTEST_SENTENCE_IPV4_ADDRESS}.)`,
  `The broker is [${SELFTEST_SENTENCE_IPV4_ADDRESS}.]`,
  `The broker is {${SELFTEST_SENTENCE_IPV4_ADDRESS}.}`,
  `Use \`${SELFTEST_SENTENCE_IPV4_ADDRESS}.\``,
  `The broker is ${SELFTEST_SENTENCE_IPV4_ADDRESS}.!`,
  `The broker is ${SELFTEST_SENTENCE_IPV4_ADDRESS}.?`,
  `The broker is ${SELFTEST_SENTENCE_IPV4_ADDRESS}.;`,
  `The broker is ["${SELFTEST_SENTENCE_IPV4_ADDRESS}."]`,
];
const SELFTEST_SENTENCE_NAME_TAIL = `Resolve ${[95, 217, 134, 22].join('.')}./path`;
const SELFTEST_LETTER_ADJACENT_IPV4 = `${SELFTEST_SENTENCE_IPV4_ADDRESS}abc`;
const SELFTEST_LETTER_ADJACENT_IPV6 = `${SELFTEST_SENTENCE_IPV6_ADDRESS}xyz`;
const SELFTEST_IPV6_HYPHEN_TAIL = `${['2a01', '4f8', '1c17', 'd00d', '', '1'].join(':')}-node`;
const SELFTEST_UNIQUE_LOCAL_IPV6 = ['fd00', '', '1'].join(':');
const SELFTEST_UNIQUE_LOCAL_IPV6_PREFIX = ['fd00', '', ''].join(':');

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
  ['ipv6-planted', 'primary=1/1 secondary=1/1'],
  ['ipv6-expanded', 'primary=1/1 secondary=1/1'],
  ['ipv6-spelling-pair', 'compressed=1/1 expanded=1/1 same_address=1/1 planted=2/2'],
  ['ipv6-documentation', 'primary=0/1 secondary=1/1'],
  ['ipv6-teredo', 'primary=0/1 secondary=1/1'],
  ['ipv6-6to4', 'primary=0/1 secondary=1/1'],
  ['ipv6-documentation-3fff', 'primary=0/1 secondary=1/1'],
  ['ipv6-globally-reachable-special-use', 'primary=1/1 secondary=1/1'],
  ['ipv6-remote-copy-target', 'primary=1/1 secondary=1/1'],
  ['ipv6-trailing-compressed-run', 'primary=1/1 secondary=1/1'],
  ['ipv6-trailing-zero-run-spelling', 'primary=1/1 secondary=1/1'],
  ['ipv6-boundary-global-unicast-first', 'primary=1/1 secondary=1/1'],
  ['ipv6-boundary-global-unicast-below', 'primary=0/1 secondary=1/1'],
  ['ipv6-boundary-global-unicast-above', 'primary=0/1 secondary=1/1'],
  ['ipv6-boundary-global-unicast-upper-half', 'primary=1/1 secondary=1/1'],
  ['ipv6-boundary-after-protocol-block', 'primary=1/1 secondary=1/1'],
  ['ipv6-boundary-inside-protocol-block', 'primary=0/1 secondary=1/1'],
  ['ipv6-boundary-after-documentation-3fff', 'primary=1/1 secondary=1/1'],
  ['ipv6-boundary-beside-documentation-db8', 'primary=1/1 secondary=1/1'],
  ['ipv6-hex-embedded-ipv4', 'ipv6_rule=0/0 ipv4_rule=1/1 hex_and_dotted_agree=1/1'],
  ['ipv6-diff-removed-line', 'primary=1/1 secondary=1/1'],
  ['sentence-final-period-ipv6', 'primary=10/10 secondary=10/10'],
  ['sentence-final-period-ipv4', 'ipv4_rule=10/10'],
  ['sentence-final-period-refuses-name', 'name_tail=0/0'],
  ['letter-adjacent-address', 'ipv4_rule=1/1 ipv6_rule=1/1'],
  ['ipv6-hyphen-suffixed-identifier', 'primary=1/1 secondary=1/1'],
  ['ipv6-documentation-network', 'primary=0/1 secondary=1/1'],
  ['ipv6-unique-local', 'primary=0/1 secondary=1/1'],
  ['ipv6-unique-local-network', 'primary=0/1 secondary=1/1'],
  ['ipv6-operator-network', 'primary=0/1 secondary=1/1'],
  ['ipv6-embedded-ipv4', 'ipv6_rule=0/0 ipv4_rule=1/1 planted=1/1'],
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
  // SELFTEST_CELL ipv6-planted START
  matchCell('ipv6-planted', `connect ${SELFTEST_PUBLIC_IPV6} now`, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-planted END
  // SELFTEST_CELL ipv6-expanded START
  matchCell('ipv6-expanded', `connect ${SELFTEST_PUBLIC_IPV6_EXPANDED} now`, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-expanded END
  // SELFTEST_CELL ipv6-spelling-pair START
  {
    id: 'ipv6-spelling-pair',
    measure: () => {
      const countFor = (text) =>
        findings(text, 'fixture', [SELFTEST_HOST]).filter((finding) => finding.rule === 'public-ipv6').length;
      const compressed = countFor(SELFTEST_PUBLIC_IPV6);
      const expanded = countFor(SELFTEST_PUBLIC_IPV6_EXPANDED);
      const sameAddress = Number(
        JSON.stringify(ipv6ToHextets(SELFTEST_PUBLIC_IPV6)) ===
          JSON.stringify(ipv6ToHextets(SELFTEST_PUBLIC_IPV6_EXPANDED)),
      );
      const planted = [SELFTEST_PUBLIC_IPV6, SELFTEST_PUBLIC_IPV6_EXPANDED].filter(
        (text) => shapeIPv6Count(text) === 1,
      ).length;
      return {
        actual: `compressed=${compressed}/1 expanded=${expanded}/1 same_address=${sameAddress}/1 planted=${planted}/2`,
        pass: compressed === 1 && expanded === 1 && sameAddress === 1 && planted === 2,
      };
    },
  },
  // SELFTEST_CELL ipv6-spelling-pair END
  // SELFTEST_CELL ipv6-documentation START
  matchCell('ipv6-documentation', SELFTEST_DOC_IPV6, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-documentation END
  // SELFTEST_CELL ipv6-documentation-network START
  matchCell('ipv6-documentation-network', `${SELFTEST_DOC_IPV6_PREFIX}/32`, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-documentation-network END
  // SELFTEST_CELL ipv6-teredo START
  matchCell('ipv6-teredo', SELFTEST_TEREDO_IPV6, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-teredo END
  // SELFTEST_CELL ipv6-6to4 START
  matchCell('ipv6-6to4', SELFTEST_6TO4_IPV6, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-6to4 END
  // SELFTEST_CELL ipv6-documentation-3fff START
  matchCell('ipv6-documentation-3fff', SELFTEST_DOC2_IPV6, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-documentation-3fff END
  // SELFTEST_CELL ipv6-globally-reachable-special-use START
  matchCell('ipv6-globally-reachable-special-use', SELFTEST_AS112_IPV6, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-globally-reachable-special-use END
  // SELFTEST_CELL ipv6-remote-copy-target START
  matchCell('ipv6-remote-copy-target', SELFTEST_IPV6_SCP, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-remote-copy-target END
  // SELFTEST_CELL ipv6-trailing-compressed-run START
  matchCell('ipv6-trailing-compressed-run', `net ${SELFTEST_IPV6_TRAILING_RUN} here`, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-trailing-compressed-run END
  // SELFTEST_CELL ipv6-trailing-zero-run-spelling START
  matchCell('ipv6-trailing-zero-run-spelling', `host ${SELFTEST_IPV6_TRAILING_ZERO_RUN} here`, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-trailing-zero-run-spelling END
  // SELFTEST_CELL ipv6-boundary-global-unicast-first START
  matchCell('ipv6-boundary-global-unicast-first', SELFTEST_IPV6_GU_FIRST, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-boundary-global-unicast-first END
  // SELFTEST_CELL ipv6-boundary-global-unicast-below START
  matchCell('ipv6-boundary-global-unicast-below', SELFTEST_IPV6_GU_BELOW, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-boundary-global-unicast-below END
  // SELFTEST_CELL ipv6-boundary-global-unicast-above START
  matchCell('ipv6-boundary-global-unicast-above', SELFTEST_IPV6_GU_ABOVE, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-boundary-global-unicast-above END
  // SELFTEST_CELL ipv6-boundary-global-unicast-upper-half START
  matchCell('ipv6-boundary-global-unicast-upper-half', SELFTEST_IPV6_GU_HALF, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-boundary-global-unicast-upper-half END
  // SELFTEST_CELL ipv6-boundary-after-protocol-block START
  matchCell('ipv6-boundary-after-protocol-block', SELFTEST_IPV6_AFTER_2001_23, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-boundary-after-protocol-block END
  // SELFTEST_CELL ipv6-boundary-inside-protocol-block START
  matchCell('ipv6-boundary-inside-protocol-block', SELFTEST_IPV6_INSIDE_2001_23, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-boundary-inside-protocol-block END
  // SELFTEST_CELL ipv6-boundary-after-documentation-3fff START
  matchCell('ipv6-boundary-after-documentation-3fff', SELFTEST_IPV6_AFTER_3FFF_20, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-boundary-after-documentation-3fff END
  // SELFTEST_CELL ipv6-boundary-beside-documentation-db8 START
  matchCell('ipv6-boundary-beside-documentation-db8', SELFTEST_IPV6_NEAR_DB8, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-boundary-beside-documentation-db8 END
  // SELFTEST_CELL ipv6-hex-embedded-ipv4 START
  {
    id: 'ipv6-hex-embedded-ipv4',
    measure: () => {
      const rulesFor = (text) => findings(text, 'fixture', [SELFTEST_HOST]).map((finding) => finding.rule);
      const hex = rulesFor(SELFTEST_IPV6_HEX_MAPPED);
      const dotted = rulesFor(SELFTEST_IPV6_HEX_MAPPED_DOTTED);
      const ipv6Rule = hex.filter((rule) => rule === 'public-ipv6').length;
      const ipv4Rule = hex.filter((rule) => rule === 'public-ipv4').length;
      const agree = Number(JSON.stringify(hex) === JSON.stringify(dotted));
      return {
        actual: `ipv6_rule=${ipv6Rule}/0 ipv4_rule=${ipv4Rule}/1 hex_and_dotted_agree=${agree}/1`,
        pass: ipv6Rule === 0 && ipv4Rule === 1 && agree === 1,
      };
    },
  },
  // SELFTEST_CELL ipv6-hex-embedded-ipv4 END
  // SELFTEST_CELL ipv6-diff-removed-line START
  matchCell('ipv6-diff-removed-line', SELFTEST_IPV6_DIFF_LINE, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-diff-removed-line END
  // SELFTEST_CELL sentence-final-period-ipv6 START
  {
    id: 'sentence-final-period-ipv6',
    measure: () => {
      const primary = SELFTEST_SENTENCE_IPV6.filter((text) => findings(text, 'fixture', [SELFTEST_HOST]).some((f) => f.rule === 'public-ipv6')).length;
      const secondary = SELFTEST_SENTENCE_IPV6.filter((text) => shapeIPv6Count(text) === 1).length;
      return { actual: `primary=${primary}/10 secondary=${secondary}/10`, pass: primary === 10 && secondary === 10 };
    },
  },
  // SELFTEST_CELL sentence-final-period-ipv6 END
  // SELFTEST_CELL sentence-final-period-ipv4 START
  {
    id: 'sentence-final-period-ipv4',
    measure: () => {
      const ipv4 = SELFTEST_SENTENCE_IPV4.filter((text) => findings(text, 'fixture', [SELFTEST_HOST]).some((f) => f.rule === 'public-ipv4')).length;
      return { actual: `ipv4_rule=${ipv4}/10`, pass: ipv4 === 10 };
    },
  },
  // SELFTEST_CELL sentence-final-period-ipv4 END
  // SELFTEST_CELL sentence-final-period-refuses-name START
  {
    id: 'sentence-final-period-refuses-name',
    measure: () => {
      const tail = findings(SELFTEST_SENTENCE_NAME_TAIL, 'fixture', [SELFTEST_HOST]).length;
      return {
        actual: `name_tail=${tail}/0`,
        pass: tail === 0,
      };
    },
  },
  // SELFTEST_CELL sentence-final-period-refuses-name END
  // SELFTEST_CELL letter-adjacent-address START
  {
    id: 'letter-adjacent-address',
    measure: () => {
      const ipv4 = findings(SELFTEST_LETTER_ADJACENT_IPV4, 'fixture', [SELFTEST_HOST])
        .filter((finding) => finding.rule === 'public-ipv4').length;
      const ipv6 = findings(SELFTEST_LETTER_ADJACENT_IPV6, 'fixture', [SELFTEST_HOST])
        .filter((finding) => finding.rule === 'public-ipv6').length;
      return {
        actual: `ipv4_rule=${ipv4}/1 ipv6_rule=${ipv6}/1`,
        pass: ipv4 === 1 && ipv6 === 1,
      };
    },
  },
  // SELFTEST_CELL letter-adjacent-address END
  // SELFTEST_CELL ipv6-hyphen-suffixed-identifier START
  matchCell('ipv6-hyphen-suffixed-identifier', SELFTEST_IPV6_HYPHEN_TAIL, 'public-ipv6', 1, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-hyphen-suffixed-identifier END
  // SELFTEST_CELL ipv6-unique-local START
  matchCell('ipv6-unique-local', SELFTEST_UNIQUE_LOCAL_IPV6, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-unique-local END
  // SELFTEST_CELL ipv6-unique-local-network START
  matchCell('ipv6-unique-local-network', `${SELFTEST_UNIQUE_LOCAL_IPV6_PREFIX}/8`, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-unique-local-network END
  // SELFTEST_CELL ipv6-operator-network START
  matchCell('ipv6-operator-network', `${SELFTEST_PUBLIC_IPV6_PREFIX}/64`, 'public-ipv6', 0, shapeIPv6Count, 1),
  // SELFTEST_CELL ipv6-operator-network END
  // SELFTEST_CELL ipv6-embedded-ipv4 START
  {
    id: 'ipv6-embedded-ipv4',
    measure: () => {
      const text = `::ffff:${SELFTEST_PUBLIC_IP}`;
      const rules = findings(text, 'fixture', [SELFTEST_HOST]);
      const ipv6Rule = rules.filter((finding) => finding.rule === 'public-ipv6').length;
      const ipv4Rule = rules.filter((finding) => finding.rule === 'public-ipv4').length;
      const planted = Number(text.includes(SELFTEST_PUBLIC_IP));
      return {
        actual: `ipv6_rule=${ipv6Rule}/0 ipv4_rule=${ipv4Rule}/1 planted=${planted}/1`,
        pass: ipv6Rule === 0 && ipv4Rule === 1 && planted === 1,
      };
    },
  },
  // SELFTEST_CELL ipv6-embedded-ipv4 END
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
