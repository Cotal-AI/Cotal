import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { codexSetupProvider } from "../src/setup.js";

const root = mkdtempSync(join(tmpdir(), "cotal-codex-enobufs-"));
const bin = join(root, "bin");
mkdirSync(bin);
const previous = process.env.PATH;
const previousCodex = process.env.CODEX_HOME;
process.env.CODEX_HOME = join(root, "codex");
writeFileSync(join(bin, "codex"), `#!/bin/sh
if [ "$2" = marketplace ]; then printf '%s\\n' '{"marketplaces":[]}'; exit 0; fi
python3 -c 'import sys; sys.stdout.write("noise\\n"*700000); sys.stdout.write("cotal@cotal-mesh  installed  0.164.0+fixture\\n"); sys.stdout.write("tail\\n"*100)'
`);
chmodSync(join(bin, "codex"), 0o755);
process.env.PATH = `${bin}:${previous ?? ""}`;
try {
  const rows = codexSetupProvider.status!({ version: "0.164.0", skillsRemedy: "cotal setup --skills" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, "Codex plugin");
  assert.equal(rows[0]!.state, "ok", rows[0]!.text);
  assert.equal(rows[0]!.text, "current");
  assert.equal(rows[0]!.text.includes("ENOBUFS"), false);
  console.log("codex plugin list buffer: 1 check passed");
  emitSentinel({ passed: 1, failed: 0 });
} finally {
  if (previous === undefined) delete process.env.PATH;
  else process.env.PATH = previous;
  if (previousCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodex;
  rmSync(root, { recursive: true, force: true });
}
