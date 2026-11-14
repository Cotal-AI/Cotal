import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { findMesh, recordMesh, refreshRegistrationPolicy } from '@cotal-ai/workspace';
import { prepareUpdateParticipant } from './update-participant.fixture.js';

const root = mkdtempSync('/var/tmp/upgrade-matrix/participant-pins-');
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
  await refreshRegistrationPolicy({ space: entry.space });
  assert(findMesh(entry.space)?.policyCheckedAt, 'real refresh must be recorded before hosted Manager setup');
  recordMesh({ ...entry, tlsRequired: !bundle.tlsRequired, policyCheckedAt: new Date(0).toISOString() });
  await assert.rejects(refreshRegistrationPolicy({ space: entry.space }), /different space, broker, transport, or user-auth trust pins/);
  recordMesh({ ...entry, policyCheckedAt: new Date(0).toISOString() });
  await refreshRegistrationPolicy({ space: entry.space });
  console.log('UPDATE PARTICIPANT PINS PASS: discovery and real registration refresh agree');
} finally { await close(); }
