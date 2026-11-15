import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { findMesh, recordMesh, refreshRegistrationPolicy } from '@cotal-ai/workspace';
import { prepareUpdateParticipant } from './update-participant.fixture.js';

const parent = '/var/tmp/upgrade-matrix';
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(parent, 'participant-pins-'));
const home = join(root, 'home'), config = join(home, 'config'), project = join(root, 'project');
for (const path of [home, config, project, join(root, 'tmp')]) mkdirSync(path, { recursive: true, mode: 0o700 });
const env = { ...process.env, HOME: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: config, TMPDIR: join(root, 'tmp') };
const report: Record<string, any> = {};
const close = await prepareUpdateParticipant({ env, project, cotalHome: env.COTAL_HOME, report });
try {
  const entry = findMesh(report.participant.space)!;
  const response = await fetch(entry.userAuth!.endpoints!.url! + '/.well-known/cotal-mesh');
  assert(response.ok);
  const bundle = await response.json() as { space: string; server: string; tlsRequired: boolean; userAuth: { endpoints: { url: string } } };
  assert.equal(entry.space, bundle.space);
  assert.equal(entry.server, bundle.server);
  assert.equal(entry.tlsRequired === true, bundle.tlsRequired, 'fixture transport pin must match its served discovery');
  assert.equal(entry.userAuth!.endpoints!.url, bundle.userAuth.endpoints.url);
  for (const path of ['http://127.0.0.1:1/exchange', '//127.0.0.1:1/exchange']) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(entry.userAuth!.endpoints!.url!, { path }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 400, 'fixture front must refuse a request naming another authority');
  }
  await refreshRegistrationPolicy({ space: entry.space });
  assert(findMesh(entry.space)?.policyCheckedAt, 'real refresh must be recorded before hosted Manager setup');
  recordMesh({ ...entry, tlsRequired: !bundle.tlsRequired, policyCheckedAt: new Date(0).toISOString() });
  await assert.rejects(refreshRegistrationPolicy({ space: entry.space }), /different space, broker, transport, or user-auth trust pins/);
  recordMesh({ ...entry, policyCheckedAt: new Date(0).toISOString() });
  await refreshRegistrationPolicy({ space: entry.space });
  console.log('UPDATE PARTICIPANT PINS PASS: discovery and real registration refresh agree');
} finally { await close(); }
await import('./upgrade-seat.fixture.js');
