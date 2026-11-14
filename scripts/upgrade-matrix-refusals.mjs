// Exact refusal contracts for public issues. Raw reports remain failed and are never rewritten.
const commonFailures = ['upgrade exits successfully', 'CLI version is target',
  'every recorded extension is at target', 'selected CLI reports target',
  'recorded extension package versions match target', 'no manual step or refusal'];
const commonSafety = ['every prior extension remains recorded', 'cotal status exits zero', 'source generation unchanged'];
const standalone = `  {{space}}: reading local Manager {{manager}} (pid {{pid}})
! legacy manager custody: PTY continuity is impossible; this update is not a hot update
  Manager {{manager}} in space "{{space}}": 1 seats
  {{space}}-worker: drain-only
  Cannot determine this Manager's original hosting command. Obtain its exact stop and start commands before stopping it; do not infer a service instance from its Manager identity.
  Next: stop this Manager through its original host, ending any seats listed above; run \`cotal update --self\`, then restart through that host with the original start command. This is a cold update, including for a Manager with 0 seats.
`;
// Set fixedIn only after a release actually carries the fix, never from a proposed release number.
export const knownRefusals = Object.freeze([
  {id: 'linux-npm-standalone-stop-consent', phases: Object.freeze(['candidate', 'published']), since: '0.164.6', fixedIn: null,
    issue: 'https://github.com/Cotal-AI/Cotal/issues/6802', exit: 1, stdout: standalone, stderr: '',
    failedAssertions: commonFailures, requiredAssertions: [...commonSafety, 'no paused recovery record', 'owned local stack cleanup succeeds']},
  {id: 'linux-npm-container-manager', phases: Object.freeze(['candidate', 'published']), sourceVersion: '0.164.6',
    issue: 'https://github.com/Cotal-AI/Cotal/issues/6785', exit: 1,
    stdout: '  {{space}}: a manager for this mesh runs on this machine; reading its custody\n',
    stderr: '✗ running manager continuity check: ✗ signed in, but the exchange for actor "cli" (view "manager-caller") was refused: manager-caller selection found no manager candidate for owner {{owner}}\n',
    failedAssertions: commonFailures, requiredAssertions: [...commonSafety, 'no paused recovery record',
      'host selected remote user-sign-in mesh before upgrade', 'foreign container Manager remains running and untouched',
      'owned local stack cleanup succeeds', 'foreign container cleanup succeeds']},
  {id: 'linux-npm-foreign-config-recovery', phases: Object.freeze(['candidate', 'published']), since: '0.0.0', fixedIn: null,
    issue: 'https://github.com/Cotal-AI/Cotal/issues/6747', exit: 3, stdout: '',
    stderr: 'Outcome unconfirmed\n  invalid update snapshot directory\n  Outcome: unknown\n  Code:    OPERATION_UNKNOWN\n',
    failedAssertions: ['upgrade exits successfully', 'CLI version is target', 'selected CLI reports target',
      'no paused recovery record', 'no manual step or refusal'],
    requiredAssertions: [...commonSafety, 'foreign snapshot bytes remain untouched',
      'every recorded extension is at target', 'recorded extension package versions match target']},
].map(entry => Object.freeze({...entry, failedAssertions: Object.freeze([...entry.failedAssertions]),
  requiredAssertions: Object.freeze([...entry.requiredAssertions])})));

function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid source release');
  return value.split('.').map(BigInt);
}
function compare(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
export function knownRefusalFor(cell, entries = knownRefusals) {
  if (!cell || typeof cell.id !== 'string' || typeof cell.phase !== 'string') throw new Error('Malformed cell');
  version(cell.sourceVersion);
  const matches = entries.filter(entry => entry.id === cell.id && entry.phases.includes(cell.phase) &&
    (entry.sourceVersion ? cell.sourceVersion === entry.sourceVersion :
      compare(cell.sourceVersion, entry.since) >= 0 &&
      (entry.fixedIn === null || compare(cell.sourceVersion, entry.fixedIn) < 0)));
  if (matches.length > 1) throw new Error('Duplicate known refusal');
  return matches[0] ?? null;
}
const normalize = value => value.replace(/\r\n/g, '\n');
const types = {space: '[a-zA-Z0-9_-]+', manager: '[a-z0-9]{31}', pid: '[1-9][0-9]*', owner: 'u_[a-z0-9]+'};
function templateMatches(template, actual) {
  const seen = new Set();
  const escaped = normalize(template).split(/(\{\{\w+\}\})/).map(part => {
    if (!part.startsWith('{{')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = part.slice(2, -2);
    if (!Object.hasOwn(types, name)) throw new Error('Unsupported template substitution');
    if (seen.has(name)) return `\\k<${name}>`;
    seen.add(name);
    return `(?<${name}>${types[name]})`;
  }).join('');
  return new RegExp(`^(?:${escaped})$(?![\\s\\S])`).test(normalize(actual));
}

// Caller verifies artifact hashes, coordinate provenance and native/source guards before calling.
// This function verifies the raw report and never turns its result into a genuine upgrade pass.
export function matchKnownRefusal(cell, report, entries = knownRefusals) {
  const entry = knownRefusalFor(cell, entries);
  if (!report || !['passed', 'failed'].includes(report.result) || !Array.isArray(report.assertions)) {
    throw new Error('Malformed refusal report');
  }
  const assertions = new Map();
  for (const assertion of report.assertions) {
    if (!assertion || typeof assertion.name !== 'string' || typeof assertion.passed !== 'boolean' || assertions.has(assertion.name)) {
      throw new Error('Malformed or duplicate assertion');
    }
    assertions.set(assertion.name, assertion);
  }
  if (report.source !== cell.sourceVersion || report.sourceRequested !== cell.sourceVersion) throw new Error('Wrong source release');
  if (!entry) return null;
  const fail = message => {throw new Error(`${entry.issue}: ${message}`);};
  if (report.result === 'passed') fail('listed cell is green, remove the known-refusal entry');
  if (report.error != null || report.cleanupFailure != null || report.cleanupSafety?.passed !== true) fail('unsafe cleanup or report error');
  if (entry.id === 'linux-npm-container-manager' &&
      (report.participant?.remote !== true || report.participant?.localManagerStarted !== false ||
       typeof report.participant?.space !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(report.participant.space) ||
       typeof report.participant?.owner !== 'string' || !/^u_[a-z0-9]+$/.test(report.participant.owner))) fail('unsafe container participant');
  if (entry.id === 'linux-npm-standalone-stop-consent' &&
      (report.agentHost !== 'standalone' || report.managerHost?.mode !== 'standalone' ||
       typeof report.managerHost?.space !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(report.managerHost.space))) fail('unsafe standalone Manager host');
  const failed = [...assertions.values()].filter(a => !a.passed).map(a => a.name).sort();
  if (JSON.stringify(failed) !== JSON.stringify([...entry.failedAssertions].sort())) fail('changed failed assertion set');
  for (const name of entry.requiredAssertions) if (assertions.get(name)?.passed !== true) fail(`missing safety assertion: ${name}`);
  if (assertions.get('CLI version is target')?.observed !== cell.sourceVersion) fail('source CLI changed');
  if (!Array.isArray(report.extensionsBefore) || !Array.isArray(report.extensionsAfter) ||
      JSON.stringify(report.extensionsBefore) !== JSON.stringify(report.extensionsAfter)) fail('source extensions changed');
  for (const extension of report.extensionsBefore) {
    if (!extension || typeof extension.pkg !== 'string' || typeof extension.version !== 'string') fail('malformed source extension');
    if (extension.pkg.startsWith('@cotal-ai/') && extension.version !== cell.sourceVersion) fail('source extension version changed');
  }
  const update = report.update;
  if (!update || update.exit !== entry.exit || update.signal !== null || update.timeout !== false ||
      typeof update.stdout !== 'string' || typeof update.stderr !== 'string') fail('changed command outcome');
  if (!templateMatches(entry.stdout, update.stdout) || !templateMatches(entry.stderr, update.stderr)) fail('changed refusal transcript');
  if (report.managerHost?.space !== undefined && !normalize(update.stdout).startsWith(`  ${report.managerHost.space}:`)) fail('wrong Manager fixture space');
  if (report.participant?.space !== undefined && !normalize(update.stdout).startsWith(`  ${report.participant.space}:`)) fail('wrong fixture space');
  if (report.participant?.owner !== undefined && !normalize(update.stderr).endsWith(`owner ${report.participant.owner}\n`)) fail('wrong fixture owner');
  const observed = assertions.get('upgrade exits successfully')?.observed;
  if (!observed || ['exit', 'signal', 'timeout', 'stdout', 'stderr'].some(key => observed[key] !== update[key])) fail('inconsistent command evidence');
  return entry;
}
