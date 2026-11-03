/**
 * `--no-input` opens no browser: after the kernel applies it, `openBrowser` spawns nothing. The
 * control spawns a stand-in opener placed first on PATH, which records the URL it was given. Windows
 * opens through `cmd`, which PATH cannot stand in for, so there the control is skipped and only the
 * refusal runs, since it spawns nothing.
 *
 * Run: pnpm smoke:web-no-input
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { disableInput } from "@cotal-ai/workspace";
import { openBrowser } from "../src/web.js";

const { check, finish } = createSuite();
const dir = mkdtempSync(join(tmpdir(), "cotal-web-no-input-"));
const opened = join(dir, "opened");
const opener = process.platform === "darwin" ? "open" : "xdg-open";
writeFileSync(join(dir, opener), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(opened)}\n`);
chmodSync(join(dir, opener), 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;

async function settled(): Promise<string | undefined> {
  for (const t0 = Date.now(); Date.now() - t0 < 5_000; await new Promise((r) => setTimeout(r, 50)))
    if (existsSync(opened)) return readFileSync(opened, "utf8");
  return undefined;
}

try {
  if (process.platform !== "win32") {
    openBrowser("http://127.0.0.1:1/control");
    check("control: the browser opener runs without --no-input", (await settled()) === "http://127.0.0.1:1/control");
    rmSync(opened, { force: true });
  }
  disableInput();
  openBrowser("http://127.0.0.1:1/refused");
  check("--no-input opens no browser", (await settled()) === undefined);
} finally {
  rmSync(dir, { recursive: true, force: true });
  finish();
}
