import { bridge, cli, serviceAt } from './bridge.mjs';
import { download, pickRelease } from './release.mjs';
import { sleep, tail, waitFor } from './proc.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Downloads and installs the release `back` steps before the target; returns its version. */
export async function installRelease(ctx, back = 0) {
  const release = await ctx.report.step(`find the published ${ctx.os.kind()} package${back ? `, ${back} release${back > 1 ? 's' : ''} back` : ''}`, () => pickRelease(ctx.os.kind(), { version: ctx.version, back }));
  ctx.report.set(back ? { from: release.version } : { version: release.version });
  const file = await ctx.report.step(`download ${release.name} and check its sha256`, () => download(release, ctx.downloads));
  const result = await ctx.report.step(`install ${release.name}`, () => ctx.os.install(file));
  ctx.report.check(`${release.name} installs`, result.code === 0, result);
  return release.version;
}

/** The installed app's own command reports `version`. */
export async function appVersion(ctx, version) {
  const call = await cli(ctx.os.app, ['--version'], 60_000);
  ctx.report.check(`the app's bundled cotal command reports ${version}`, call.code === 0 && call.stdout.includes(version), tail(call.stdout || call.stderr, 300));
}

/** Opens the app as a person would and checks it shows its window and stays up. */
export async function openApp(ctx) {
  const pid = await ctx.report.step('open the app', () => ctx.os.launch(ctx.out));
  const shown = await waitFor(() => ctx.os.window(pid, ctx.out), { timeout: 90_000, interval: 2000 });
  ctx.report.check('the app shows its window within 90 s', shown.ok, shown);
  await sleep(15_000);
  ctx.report.check('the app is still running 15 s later', alive(pid));
  ctx.appPid = pid;
  return pid;
}

export async function quitApp(ctx) {
  if (!ctx.appPid) return;
  await ctx.report.step('quit the app', () => ctx.os.quit(ctx.appPid));
  ctx.appPid = undefined;
}

/** What the app's Continue button does first: prepare the background service. Then it must answer. */
export async function setUpService(ctx, version) {
  const install = await ctx.report.step('set up the background service the way the app does', () => bridge(ctx.os.app, { op: 'install' }));
  ctx.report.check('the app sets up the background service', install.ok, install);
  const at = await serviceAt(ctx.os.app, version);
  ctx.report.check(`the background service answers at ${version}`, at.ok, at);
}

/** The app reads the service's status, including who is signed in. */
export async function signInState(ctx, expected) {
  const status = await bridge(ctx.os.app, { op: 'status' }, 60_000);
  const mode = status.result?.result?.account?.mode;
  ctx.report.check(`the app reads the service status: ${expected}`, status.ok && mode === expected, status.ok ? { mode } : status);
  return status.result?.result;
}

/** The agent applications the app lists, by name and state. */
export async function agentApps(ctx) {
  const listed = await bridge(ctx.os.app, { op: 'agent-apps', refresh: true }, 120_000);
  ctx.report.check('the app lists agent applications', listed.ok && Array.isArray(listed.result?.result?.apps), listed);
  return Object.fromEntries(listed.result.result.apps.map((app) => [app.name, app.state]));
}
