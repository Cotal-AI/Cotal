import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** Record only phase boundaries and allowlisted observations from calls the fixture already makes. */
export function windowsPhaseReceipt(output, enabled = process.platform === 'win32') {
  let sequence = 0;
  const write = row => {
    if (!enabled) return;
    try {
      appendFileSync(join(output, 'windows-fixture-phases.jsonl'), `${JSON.stringify({ schema: 1, at: new Date().toISOString(), monotonicMs: performance.now(), pid: process.pid, ...row })}\n`, { mode: 0o600 });
    } catch {
      console.error('Windows fixture phase receipt unavailable');
    }
  };
  return async (phase, operation, observation) => {
    if (!enabled) return operation();
    const id = ++sequence;
    write({ id, phase, kind: 'start' });
    try {
      const result = await operation();
      // Call sites supply a small projection, never an environment, credential or full protocol reply.
      let projected;
      if (observation) {
        try { projected = observation(result); }
        catch { projected = { status: 'unknown', reason: 'PROJECTION_FAILED' }; }
      }
      write({ id, phase, kind: 'complete', ...(observation ? { observation: projected } : {}) });
      return result;
    } catch (error) {
      let failure = { name: 'unknown' };
      try { failure = { name: error instanceof Error ? error.name : 'unknown', code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : undefined }; }
      catch { /* Diagnostic metadata never replaces the original thrown value. */ }
      write({ id, phase, kind: 'failed', error: failure });
      throw error;
    }
  };
}
