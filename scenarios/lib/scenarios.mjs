import { bridge, daemonStatus } from './bridge.mjs';
import { offline, online } from './network.mjs';
import { shell, tail } from './proc.mjs';
import { pickRelease } from './release.mjs';
import { agentApps, appVersion, installRelease, openApp, quitApp, setUpService, signInState } from './steps.mjs';

/** Every check a person relies on right after installing: the app opens, its service runs, nobody is signed in. */
async function appWorks(ctx, version) {
  await appVersion(ctx, version);
  await openApp(ctx);
  await setUpService(ctx, version);
  await signInState(ctx, 'signed-out');
}

async function fresh(ctx) {
  const version = await installRelease(ctx);
  await appWorks(ctx, version);
  await agentApps(ctx);
}

function upgrade(back) {
  return async (ctx) => {
    const from = await installRelease(ctx, back);
    await appVersion(ctx, from);
    await openApp(ctx);
    await setUpService(ctx, from);
    await quitApp(ctx);
    const to = await installRelease(ctx);
    await appVersion(ctx, to);
    await openApp(ctx);
    const status = await signInState(ctx, 'signed-out');
    ctx.report.check(`after the upgrade the background service runs ${to} without being set up again`, status?.version === to, { version: status?.version ?? null });
  };
}

/** A person who installed the command line with npm and set up its service, then installs the app. */
async function npmFirst(ctx) {
  const target = await ctx.report.step('find the target release', () => pickRelease(ctx.os.kind(), { version: ctx.version }));
  ctx.report.set({ version: target.version });
  await ctx.report.step('make sure Node and npm are installed, as a person using npm has them', () => ctx.os.ensureNpm(ctx.downloads));
  const npm = await ctx.report.step(`npm install -g cotal-ai@${target.version}`, () => ctx.os.npmGlobal(`cotal-ai@${target.version}`));
  ctx.report.check('npm installs the cotal command', npm.code === 0, tail(npm.stderr || npm.stdout, 800));
  const service = await ctx.report.step('cotal daemon install', () => shell('cotal daemon install --json', { timeout: 180_000 }));
  ctx.report.check("the npm command line sets up its background service", service.code === 0, tail(service.stdout || service.stderr, 800));
  await installRelease(ctx);
  await appVersion(ctx, target.version);
  await openApp(ctx);
  const read = await daemonStatus(ctx.os.app);
  ctx.report.check(`the app's command sees one background service at ${target.version}`, read.ok && read.status?.version === target.version, { version: read.status?.version ?? null, code: read.code });
  await signInState(ctx, 'signed-out');
  const onPath = await shell('cotal --version');
  ctx.report.check(`cotal on PATH still reports ${target.version}`, onPath.code === 0 && onPath.stdout.includes(target.version), tail(onPath.stdout || onPath.stderr, 300));
}

/** The package is already on the machine, but Cotal's services, GitHub and npm cannot be reached. */
async function offlineFirstLaunch(ctx) {
  const version = await installRelease(ctx);
  await ctx.report.step('cut off Cotal, GitHub and npm', () => offline(ctx.os));
  try {
    await appWorks(ctx, version);
    const check = await ctx.report.step('check for updates while offline', () => bridge(ctx.os.app, { op: 'update-check' }, 120_000));
    ctx.report.check('the update check answers within 120 s while offline', !check.timedOut && check.result !== null, check);
  } finally {
    await ctx.report.step('reconnect', () => online(ctx.os));
  }
  const check = await bridge(ctx.os.app, { op: 'update-check' }, 120_000);
  ctx.report.check('the update check answers once back online', check.ok, check);
}

export const SCENARIOS = [
  { name: 'fresh', title: 'Fresh machine, latest release', run: fresh },
  { name: 'upgrade-1', title: 'Upgrade from the previous release', run: upgrade(1) },
  { name: 'upgrade-2', title: 'Upgrade from 2 releases back', run: upgrade(2) },
  { name: 'upgrade-3', title: 'Upgrade from 3 releases back', run: upgrade(3) },
  { name: 'npm-first', title: 'cotal already installed with npm', run: npmFirst },
  { name: 'offline', title: 'Offline at first launch', run: offlineFirstLaunch },
];
