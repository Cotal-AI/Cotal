import { readFileSync, writeFileSync } from 'node:fs';
if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('Traced installer requires a disposable runner.');
const directory = 'desktop/src-tauri/installers/';
function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`Trace anchor is not singular: ${anchor}`);
  return source.replace(anchor, replacement);
}
let helper = readFileSync(`${directory}service-update.mjs`, 'utf8').replaceAll('\r\n', '\n');
helper = once(helper, "import { existsSync,", "import { appendFileSync, existsSync,");
helper = once(helper, "const stateFile =", `const trace = step => appendFileSync(join(directory, 'helper-trace.log'), JSON.stringify({ at: new Date().toISOString(), mode, step, pid: process.pid }) + '\\n');
trace('entry');
process.on('exit', code => trace('exit:' + code));
const stateFile =`);
for (const [anchor, replacement] of [
  ["const task = action => {", "const task = action => {\n  trace('task:' + action);"],
  ["async function load() {", "async function load() {\n  trace('load');"],
  ["async function request(op, commit = false) {", "async function request(op, commit = false) {\n  trace('request:' + op + ':' + commit);"],
  ["const response = JSON.parse(await pending);", "const response = JSON.parse(await pending);\n  trace('response:' + op + ':' + commit);"],
  ["async function waitDead() {", "async function waitDead() {\n  trace('waitDead');"],
  ["if (modules.lifetime.processBirth(state.oldPid) !== state.oldBirth && await absent()) {", "trace('waitDead:birth:' + modules.lifetime.processBirth(state.oldPid));\n    if (modules.lifetime.processBirth(state.oldPid) !== state.oldBirth && await absent()) {"],
  ["async function absent() {", "async function absent() {\n  trace('absent');"],
  ["async function finish(rollback = false) {", "async function finish(rollback = false) {\n  trace('finish:' + rollback);"],
  ["} catch (error) {\n  const active", "} catch (error) {\n  trace('catch:' + error.message);\n  const active"],
]) helper = once(helper, anchor, replacement);
writeFileSync(`${directory}traced-service-update.mjs`, helper);
let hooks = readFileSync(`${directory}hooks.nsh`, 'utf8').replaceAll('\r\n', '\n');
hooks = once(hooks, 'Var CotalFresh', 'Var CotalFresh\nVar CotalTracePhase');
hooks = once(hooks, 'Function CotalHelperExit\n', `Function CotalHelperExit
  Push $9
  FileOpen $9 "$LOCALAPPDATA\\CotalSetup\\hook-trace.log" a
  FileWrite $9 "$CotalTracePhase: $CotalCode$\\r$\\n"
  FileClose $9
  Pop $9
`);
hooks = once(hooks, 'File /oname=service-update.mjs "${COTAL_HOOK_DIR}\\service-update.mjs"', 'File /oname=service-update.mjs "${COTAL_HOOK_DIR}\\traced-service-update.mjs"');
for (const phase of ['recover', 'prepare', 'finish', 'abort']) {
  const lines = hooks.split('\n');
  const indexes = lines.flatMap((line, index) => line.includes('nsExec::') && (phase === 'recover' ? line.includes('-Action recover') : line.includes(`service-update.mjs" ${phase} `)) ? [index] : []);
  if (indexes.length !== 1) throw new Error(`Trace invocation is not singular: ${phase}`);
  lines.splice(indexes[0], 0, `  StrCpy $CotalTracePhase "${phase}"`);
  hooks = lines.join('\n');
}
writeFileSync(`${directory}traced-hooks.nsh`, hooks);
writeFileSync('desktop/src-tauri/traced-helper.json', JSON.stringify({ bundle: { windows: { nsis: { installerHooks: 'installers/traced-hooks.nsh' } } } }));
