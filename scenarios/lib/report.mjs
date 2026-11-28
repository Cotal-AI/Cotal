import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class ScenarioFailed extends Error {}

/** One scenario's record: the steps it took and the checks it made, saved after every change. */
export class Report {
  constructor(out, fields) {
    this.out = out;
    mkdirSync(out, { recursive: true });
    this.data = { ...fields, startedAt: new Date().toISOString(), outcome: 'running', steps: [], checks: [] };
    this.save();
  }

  save() {
    writeFileSync(join(this.out, 'result.json'), `${JSON.stringify(this.data, null, 2)}\n`);
  }

  set(fields) {
    Object.assign(this.data, fields);
    this.save();
  }

  async step(name, action) {
    const started = Date.now();
    console.log(`- ${name}`);
    const row = { name, ok: false, ms: 0 };
    this.data.steps.push(row);
    try {
      const detail = await action();
      Object.assign(row, { ok: true, ms: Date.now() - started }, detail === undefined ? {} : { detail });
      return detail;
    } catch (error) {
      Object.assign(row, { ms: Date.now() - started, error: String(error?.message ?? error) });
      throw error;
    } finally {
      this.save();
    }
  }

  /** Records a check. A failed check stops the scenario unless `soft` is set. */
  check(name, passed, detail, { soft = false } = {}) {
    const row = { name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) };
    this.data.checks.push(row);
    this.save();
    console.log(`  ${row.passed ? 'PASS' : 'FAIL'} ${name}${row.passed || detail === undefined ? '' : `: ${short(detail)}`}`);
    if (!row.passed && !soft) throw new ScenarioFailed(name);
    return row.passed;
  }

  finish(outcome, reason) {
    const failed = this.data.checks.filter((row) => !row.passed).map((row) => row.name);
    this.set({ outcome, ...(reason ? { reason } : {}), failed, finishedAt: new Date().toISOString() });
  }
}

function short(detail) {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}
