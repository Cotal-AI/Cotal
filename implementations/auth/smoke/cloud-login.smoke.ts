import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins/jwt';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { bearer } from 'better-auth/plugins/bearer';
import { toNodeHandler } from 'better-auth/node';
import { chooseAccount } from '../src/commands.js';
import { COTAL_CLOUD_IDP } from '@cotal-ai/workspace';
import { approveDevice } from './_device-approval.js';

const home = mkdtempSync(join(tmpdir(), 'cotal-cloud-login-'));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_')));
process.env.COTAL_HOME = join(home, 'cotal');
process.env.XDG_CONFIG_HOME = join(home, 'config');
mkdirSync(process.env.COTAL_HOME, { mode: 0o700 });
assert.equal(await chooseAccount({ values: {}, positionals: [], raw: [] }, 'login'), COTAL_CLOUD_IDP);
assert.equal(await chooseAccount({ values: { cloud: true }, positionals: [], raw: [] }, 'login'), COTAL_CLOUD_IDP);
console.log('Fresh provider selection defaults directly to Cloud; --cloud selects it explicitly.');
const env = { ...cleanEnv, HOME: home, COTAL_HOME: process.env.COTAL_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SKIP_CONNECTOR_SEED: '0', COTAL_ALLOW_CHECKOUT_SEED: '1' };

let handler: ReturnType<typeof toNodeHandler>;
let sub = '';
let shape: 'personal' | 'sole-team' | 'personal-team' | 'teams' = 'personal';
const catalogSpaces = () => {
  const kinds = shape === 'personal' ? ['personal'] : shape === 'sole-team' ? ['team'] : shape === 'personal-team' ? ['team', 'personal'] : ['team', 'team'];
  return kinds.map((kind, index) => {
    const space = kind === 'personal' ? 'personal' : `team_${index}`;
    return { id: space, slug: space, name: space, kind, role: 'owner', registration: { space, server: 'nats://127.0.0.1:49999', tlsRequired: false, sentinelCreds: 'catalog-fixture-sentinel', userAuth: { provider: 'cotal', idp: { url: base, issuer: origin, audience: origin }, endpoints: { url: `${origin}/exchange` } } } };
  });
};
const server = createServer((req, res) => {
  if (req.url === '/spaces') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ v: 1, account: { idpUrl: base, issuer: origin, sub }, spaces: catalogSpaces() }));
    return;
  }
  if (req.url?.split('?')[0] === '/api/auth/token') res.setHeader('link', `<${origin}/spaces>; rel="https://cotal.ai/relations/space-catalog"`);
  handler(req, res);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
const base = `${origin}/api/auth`;
const ba = betterAuth({ baseURL: origin, secret: 'smoke-only-better-auth-secret-0123456789', database: memoryAdapter({user:[],session:[],account:[],verification:[],jwks:[],deviceCode:[]}), emailAndPassword: {enabled:true}, plugins: [jwt({jwt:{issuer:origin,audience:origin}}), deviceAuthorization({expiresIn:'2m',interval:'1s',validateClient:id=>id==='cotal-cli'}),bearer()] });
handler = toNodeHandler(ba);
const signup = await ba.api.signUpEmail({body:{email:'lane@example.test',password:'lane-only-smoke-password',name:'Lane User'},returnHeaders:true});
sub = signup.response.user.id;
const cookie = signup.headers.get('set-cookie')!.split(';')[0];
let output = '';
let approval: Promise<void> | undefined;
const child = spawn('./node_modules/.bin/tsx', ['bin/cotal.ts','login','--idp',base,'--plain'], {env,stdio:['ignore','pipe','pipe']});
const capture = (chunk: Buffer) => {
  output += chunk.toString();
  const match = output.match(/Approval code:\s+(\S+)/);
  if (match && !approval) approval = approveDevice({base,cookie,origin},match[1]);
};
child.stdout.on('data',capture); child.stderr.on('data',capture);
const timer = setTimeout(()=>child.kill('SIGTERM'),30_000);
try {
  const code = await new Promise<number|null>(resolve=>child.on('close',resolve));
  await approval;
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /wrote operator-global seed store payload|added @cotal-ai\//);
  assert.equal(existsSync(join(env.XDG_CONFIG_HOME!, 'cotal', 'seed')), false);
  assert.equal(existsSync(join(env.XDG_CONFIG_HOME!, 'cotal', 'extensions.json')), false);
  assert.match(output, /Selected personal/);
  assert.match(output, /cotal status/);
  assert.match(output, /cotal chat/);
  assert.equal(readFileSync(join(env.COTAL_HOME!, 'current-mesh'), 'utf8').trim(), 'personal');
  assert.equal(readFileSync(join(env.COTAL_HOME!, 'current-mesh.adopted'), 'utf8').trim(), 'personal');
  console.log('Real Better Auth approval through CLI selects personal space and names next commands.');
  for (const cell of [
    { shape: 'sole-team' as const, expected: 'team_0' },
    { shape: 'personal-team' as const, expected: 'personal' },
    { shape: 'teams' as const, expected: undefined },
    { shape: 'personal-team' as const, expected: 'kept', previous: 'kept' },
  ]) {
    shape = cell.shape;
    const dir = mkdtempSync(join(home, 'cell-'));
    if (cell.previous) writeFileSync(join(dir, 'current-mesh'), cell.previous, { mode: 0o600 });
    let text = '';
    let approved: Promise<void> | undefined;
    const login = spawn('./node_modules/.bin/tsx', ['bin/cotal.ts', 'login', '--idp', base, '--plain'], { env: { ...env, COTAL_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk: Buffer) => {
      text += chunk.toString();
      const match = text.match(/Approval code:\s+(\S+)/);
      if (match && !approved) approved = approveDevice({ base, cookie, origin }, match[1]);
    };
    login.stdout.on('data', collect); login.stderr.on('data', collect);
    const deadline = setTimeout(() => login.kill('SIGTERM'), 30_000);
    try {
      assert.equal(await new Promise(resolve => login.on('close', resolve)), 0, text);
      await approved;
      const selected = existsSync(join(dir, 'current-mesh')) ? readFileSync(join(dir, 'current-mesh'), 'utf8').trim() : undefined;
      assert.equal(selected, cell.expected, text);
      if (!cell.expected) { assert.match(text, /cotal use <name>/); assert.match(text, /team_0/); assert.match(text, /team_1/); }
      console.log(`Real provider landing ${cell.shape}${cell.previous ? ' preserves existing selection' : ''}: passed`);
    } finally { clearTimeout(deadline); }
  }
} finally {
  clearTimeout(timer);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
