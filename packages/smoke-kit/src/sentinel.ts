/**
 * Machine-readable terminal sentinel a smoke suite prints with its cell counts.
 *
 * `shard.mjs` used to grade a suite on exit status alone, so `process.exit(0)` with zero cells
 * was indistinguishable from a full pass. The shard now parses this sentinel from the suite's
 * own output and refuses a missing line or a zero-cell run.
 *
 * Keep this file in lockstep with `bin/smoke/sentinel.mjs` (the node-loadable copy the shard
 * imports). Suites should print the canonical line through {@link emitSentinel} as their last
 * output.
 */
export const SENTINEL_PREFIX = "COTAL_SMOKE_SENTINEL";

export function formatSentinel({
  passed,
  failed,
  cells,
}: {
  passed: number;
  failed: number;
  cells?: number;
}): string {
  const p = Number(passed);
  const f = Number(failed);
  const c = cells === undefined ? p + f : Number(cells);
  return `${SENTINEL_PREFIX} cells=${c} passed=${p} failed=${f}`;
}

export function emitSentinel(counts: { passed: number; failed: number; cells?: number }): void {
  console.log(formatSentinel(counts));
}

export type ParsedSentinel = {
  cells: number;
  passed: number;
  failed: number;
  kind: "canonical" | "legacy";
};

export function parseSentinel(text: string): ParsedSentinel | null {
  let last: ParsedSentinel | null = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const canonical = line.match(/^COTAL_SMOKE_SENTINEL cells=(\d+) passed=(\d+) failed=(\d+)$/);
    if (canonical) {
      last = {
        cells: Number(canonical[1]),
        passed: Number(canonical[2]),
        failed: Number(canonical[3]),
        kind: "canonical",
      };
      continue;
    }
    // A legacy banner must own the whole line. Trailing `;…` or a double-space
    // annotation is extra, not a new clause. A single space then words is prose
    // and must not mint a tally. Optional `label:` is the suite name, not English
    // wrapping the number.
    const pair = line.match(/^.*\((\d+) passed, (\d+) failed(?:;[^)]*)?\)(?:(?:;|\s{2}).*)?$/);
    if (pair) {
      const passed = Number(pair[1]);
      const failed = Number(pair[2]);
      last = { cells: passed + failed, passed, failed, kind: "legacy" };
      continue;
    }
    const suiteComplete = line.match(/^(?:SUITE COMPLETE:\s*)?(?:.*?:\s*)?(\d+) passed, (\d+) failed(?:(?:;|\s{2}).*)?$/);
    if (suiteComplete) {
      const passed = Number(suiteComplete[1]);
      const failed = Number(suiteComplete[2]);
      last = { cells: passed + failed, passed, failed, kind: "legacy" };
      continue;
    }
    const cellsGreen = line.match(/^(\d+) cells green$/);
    if (cellsGreen) {
      const cells = Number(cellsGreen[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const cellsOk = line.match(/^(?:.*?:\s*)?(\d+) cells OK(?:, \d+ failed)?(?:(?:;|\s{2}).*)?$/);
    if (cellsOk) {
      const cells = Number(cellsOk[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const testsExecuted = line.match(/^(?:.*?:\s*)?(\d+) tests executed(?:(?:;|\s{2}).*)?$/);
    if (testsExecuted) {
      const cells = Number(testsExecuted[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const parenTests = line.match(/^.*\((\d+) tests\)(?:(?:;|\s{2}).*)?$/);
    if (parenTests) {
      const cells = Number(parenTests[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const slash = line.match(/^(\d+)\/(\d+) passed$/);
    if (slash) {
      const passed = Number(slash[1]);
      const cells = Number(slash[2]);
      last = { cells, passed, failed: cells - passed, kind: "legacy" };
      continue;
    }
    const checksOnly = line.match(/^.*\((\d+) checks(?: passed)?\)(?:(?:;|\s{2}).*)?$/);
    if (checksOnly) {
      const cells = Number(checksOnly[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const suiteCells = line.match(/^SUITE COMPLETE:\s*(\d+) cells$/);
    if (suiteCells) {
      const cells = Number(suiteCells[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const scanned = line.match(/^(?:.*?:\s*)?(\d+) (?:documents checked|source files scanned|files scanned)(?:, .*)?$/);
    if (scanned) {
      const cells = Number(scanned[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const names = line.match(/^(?:.*?:\s*)?(\d+) names across (\d+) imports(?:(?:;|\s{2}).*)?$/);
    if (names) {
      const cells = Number(names[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const named = line.match(/^(?:.*?:\s*)?(\d+) named registrations(?: across \d+.*)?$/);
    if (named) {
      const cells = Number(named[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const filesDecls = line.match(/^(?:.*?:\s*)?(\d+) files, (\d+) declarations(?:, .*)?$/);
    if (filesDecls) {
      const cells = Number(filesDecls[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const checksPassed = line.match(/^(?:.*?:\s*)?(\d+) checks passed(?:(?:;|\s{2}).*)?$/);
    if (checksPassed) {
      const cells = Number(checksPassed[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const cellsPassed = line.match(/^(?:.*?:\s*)?(\d+) cells passed(?:(?:;|\s{2}).*)?$/);
    if (cellsPassed) {
      const cells = Number(cellsPassed[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const cellsDash = line.match(/^(?:.*?:\s*)?(\d+) cells - \S.*$/);
    if (cellsDash) {
      const cells = Number(cellsDash[1]);
      last = { cells, passed: cells, failed: 0, kind: "legacy" };
      continue;
    }
    const okFailed = line.match(/^(?:.*?:\s*)?(\d+) ok, (\d+) failed(?:(?:;|\s{2}).*)?$/);
    if (okFailed) {
      const passed = Number(okFailed[1]);
      const failed = Number(okFailed[2]);
      last = { cells: passed + failed, passed, failed, kind: "legacy" };
      continue;
    }
  }
  if (last) return last;
  const passed =
    (String(text).match(/^\s*✓/gm) ?? []).length +
    (String(text).match(/^\s*ok(?: -)? /gm) ?? []).length;
  const failed =
    (String(text).match(/^\s*✗/gm) ?? []).length +
    (String(text).match(/^not ok - /gm) ?? []).length +
    (String(text).match(/^\s*FAIL {2}/gm) ?? []).length;
  if (passed + failed > 0) return { cells: passed + failed, passed, failed, kind: "legacy" };
  return null;
}

export function countedAssert<T extends object>(ns: T): { assert: T; cells: () => number } {
  let cells = 0;
  const assert = new Proxy(ns, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        cells += 1;
        return value.apply(target, args);
      };
    },
  });
  return { assert: assert as T, cells: () => cells };
}

export function createSuite(): {
  check: (name: string, cond: boolean, extra?: unknown) => void;
  finish: () => void;
  passed: () => number;
  failed: () => number;
} {
  let passed = 0;
  let failed = 0;
  const check = (name: string, cond: boolean, extra?: unknown): void => {
    if (cond) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.log(`  ✗ FAIL: ${name}`, extra ?? "");
    }
  };
  const finish = (): void => {
    emitSentinel({ passed, failed });
    if (failed) process.exitCode = 1;
  };
  return {
    check,
    finish,
    passed: () => passed,
    failed: () => failed,
  };
}
