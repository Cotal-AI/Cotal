#!/usr/bin/env node
// Pre-flight for a mutation config. A mutation that does not resolve, does not parse, or names a
// variable the mutant never binds is a BROKEN INSTRUMENT, not a finding: it reports ERROR or
// WRONG-RED and costs a full sweep to discover. Run this before the sweep, which is cheap.
//
// The undefined-name check exists because a mutant that dropped `reader = self._reader` while the
// code after it still joined `reader` parsed perfectly and then died with NameError at runtime. The
// harness graded that as WRONG-RED, which is correct but reads like a coverage problem rather than
// a typo in the config.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error("usage: mutation-preflight.mjs <config.json>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
let bad = 0;
for (const m of cfg.mutations ?? []) {
  const src = readFileSync(m.file, "utf8");
  const parts = src.split(m.find);
  const resolves = parts.length - 1;
  const mutant = resolves === 1 ? parts[0] + (m.replace ?? "") + parts[1] : null;
  let compiles = "skipped";
  let names = "skipped";
  if (mutant !== null && m.file.endsWith(".py")) {
    // Write the scratch file OUTSIDE the package. Writing it beside the source made CPython drop
    // its bytecode into that package's __pycache__/, which `git status` ignores and which the
    // cleanup below could not reach: it removed a sibling .pyc, and CPython writes into
    // __pycache__/ instead. Every run left an orphan behind in a directory that ships.
    const tmp = join(mkdtempSync(join(tmpdir(), "mutation-preflight-")), "candidate.py");
    writeFileSync(tmp, mutant);
    try {
      execFileSync("python3", ["-m", "py_compile", tmp], { stdio: "pipe" });
      compiles = "ok";
      // Undefined-name check with NO new dependency: compile the mutated function and ask CPython
      // which names it reads but never binds, which is exactly the NameError class. `co_names` are
      // the global/attribute reads; a local read before assignment shows up as a free variable that
      // is neither in co_varnames-with-a-store nor a builtin nor a module global.
      // Undefined-name check via CPython's own scope analysis (symtable), no new dependency and no
      // hand-rolled AST scoping. A name that a function resolves at GLOBAL scope, that is bound
      // nowhere at module scope and is not a builtin, can only raise NameError when that line runs.
      // This is exactly the mutant that deleted `reader = self._reader` while the code below still
      // joined it: it parsed, compiled, and died at runtime, and the sweep graded it WRONG-RED.
      const probe = [
        "import symtable, sys, builtins",
        "src = open(" + JSON.stringify(tmp) + ").read()",
        "st = symtable.symtable(src, 'm', 'exec')",
        "mod = {s.get_name() for s in st.get_symbols() if s.is_assigned() or s.is_imported()}",
        "bad = []",
        "def walk(t):",
        "    yield t",
        "    for ch in t.get_children(): yield from walk(ch)",
        "for t in walk(st):",
        "    if t.get_type() != 'function': continue",
        "    for sym in t.get_symbols():",
        "        n = sym.get_name()",
        "        if sym.is_local() or sym.is_parameter() or sym.is_free(): continue",
        "        if n in mod or hasattr(builtins, n): continue",
        "        bad.append(t.get_name() + ':' + n)",
        "print('UNDEFINED ' + ','.join(sorted(set(bad))) if bad else 'CLEAN')",
      ].join("\n");
      try {
        const out = execFileSync("python3", ["-c", probe], { stdio: "pipe" }).toString().trim();
        names = out.startsWith("UNDEFINED") ? `UNDEFINED-NAME(${out.slice(10)})` : "ok";
      } catch (e) {
        names = `CHECK-FAILED(${String(e.message ?? e).slice(0, 40)})`;
      }
    } catch {
      compiles = "SYNTAX-ERROR";
    } finally {
      // Remove the whole scratch directory, so bytecode cannot outlive the source that made it.
      try { rmSync(dirname(tmp), { recursive: true, force: true }); } catch {}
    }
  }
  const okRow = resolves === 1 && compiles !== "SYNTAX-ERROR" && !names.startsWith("UNDEFINED-NAME");
  if (!okRow) bad += 1;
  console.log(
    `${okRow ? "OK  " : "BAD "} resolves=${resolves} compiles=${compiles} names=${names}  ${m.name}`,
  );
}
console.log(`PREFLIGHT_SUMMARY bad=${bad} of ${(cfg.mutations ?? []).length}`);
process.exit(bad === 0 ? 0 : 1);
