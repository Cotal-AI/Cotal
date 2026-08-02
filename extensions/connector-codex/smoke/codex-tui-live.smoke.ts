/**
 * Live E2E for the Codex TUI — the claim that `cotal spawn --agent codex` puts you in Codex
 * proper, and that the cotal_* tools work on a turn a HUMAN typed there.
 *
 * This is the case the connector's first design got wrong. App-server `dynamicTools` are routed
 * back to whichever client owns the turn: fine while the host is the only client, but a turn
 * typed into the attached TUI belongs to the TUI, which refuses outright ("Dynamic tool calls are
 * not available in TUI yet"). The mesh tools existed on mesh-driven turns and vanished on
 * human-driven ones. Serving them over MCP instead makes the app-server itself the tool client,
 * so both kinds of turn reach them.
 *
 * So this drives the REAL binary through a REAL pty (`expect`), types a message into the TUI as a
 * person would, and asserts the message came back OVER THE MESH — the only proof that a
 * TUI-initiated turn can call cotal_*. Needs an authenticated codex + `expect`, so it is gated
 * behind COTAL_E2E_CODEX=1 and skips otherwise.
 *
 * Run: COTAL_E2E_CODEX=1 pnpm smoke:codex-tui-live
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";

if (!/^(1|true|yes|on)$/i.test(process.env.COTAL_E2E_CODEX ?? "")) {
  console.log("SKIP codex TUI live E2E — set COTAL_E2E_CODEX=1 (needs an authenticated `codex` CLI) to run it");
  process.exit(0);
}
if (spawnSync("sh", ["-c", "command -v expect"], { encoding: "utf8" }).status !== 0) {
  console.log("SKIP codex TUI live E2E — needs `expect` on PATH to drive a real pty");
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "codextui";
const PEER = "codextuipeer";
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const HOST_ENTRY = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "cotal-codextui-"));
const nats = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });

const operator = new CotalEndpoint({
  space,
  servers,
  card: { name: "operator", kind: "agent", id: "operator" },
  channels: ["team"],
});
operator.on("error", () => {});
let reply = "";
operator.on(
  "message",
  (msg: { parts?: { kind: string; text?: string }[] }, _d: unknown, meta: { kind: string; historical: boolean }) => {
    if (meta.historical || meta.kind !== "dm") return;
    reply += (msg.parts ?? []).filter((p) => p.kind === "text").map((p) => p.text ?? "").join("");
  },
);
let online = false;
operator.on("presence", (e: { type: string; presence: { card: { id: string; name: string } } }) => {
  const c = e.presence.card;
  if ((c.id === PEER || c.name === PEER) && e.type !== "offline") online = true;
});

// The message a person types into the TUI. It asks for a cotal tool call and nothing else, so a
// mesh DM arriving at the operator can only have come from a TUI-initiated turn.
const TYPED = "Use your cotal_dm tool to send exactly the single word TUIPONG to the peer named operator. Do not run any commands.";

const expectScript = join(dir, "drive-tui.exp");
writeFileSync(
  expectScript,
  `#!/usr/bin/env expect -f
# A pty is mandatory: the host only attaches the TUI when stdout is a terminal, and codex needs a
# real terminal to paint into. \`expect\` also has to keep READING, or the pty buffer fills and
# the UI blocks — hence the exp_continue drain loops rather than a bare sleep.
#
# The pty needs an explicit SIZE. expect inherits its window size from its own stdout, which here
# is a pipe, so the pty comes up 0x0 and codex wraps the composer at one column — the message is
# typed but never becomes a submittable line.
set stty_init "rows 40 columns 120"
set timeout 120
spawn -noecho $env(TSX) $env(HOST_ENTRY)

# Wait for Codex to paint. Any of its chrome will do; we only need it to be up and accepting keys.
expect {
  -re {Codex|codex|>_|▌|/status} {}
  timeout { puts "\\nDRIVER: no TUI paint within timeout"; exit 3 }
}
# Let the composer settle before typing (a keystroke into a half-painted UI is dropped).
set timeout 12
expect { -re {.+} { exp_continue } timeout {} }

# Type, let the composer settle, THEN submit. Codex treats a fast character burst as a paste, so
# a \\r riding the same burst can land inside the pasted block instead of submitting it.
send -- "$env(TYPED)"
set timeout 6
expect { -re {.+} { exp_continue } timeout {} }
send -- "\\r"
puts "\\nDRIVER: typed the message"

# Drain while the turn runs, until the tool call shows up or we run out of patience.
set timeout 300
expect {
  -re {cotal_dm|TUIPONG} { puts "\\nDRIVER: saw the tool call" }
  timeout { puts "\\nDRIVER: no tool call observed" }
}
set timeout 45
expect { -re {.+} { exp_continue } timeout {} eof {} }
puts "\\nDRIVER: done"
exit 0
`,
);

let driver: ReturnType<typeof spawn> | undefined;
let driverOut = "";
try {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) break;
    await sleep(200);
  }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await operator.start();

  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];
  driver = spawn("expect", ["-f", expectScript], {
    env: {
      ...cleanEnv,
      TSX,
      HOST_ENTRY,
      TYPED,
      COTAL_SPACE: space,
      COTAL_NAME: PEER,
      COTAL_ID: PEER,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ROLE: "coder",
      COTAL_CODEX_HOME: dir,
      COTAL_CODEX_TUI: "1", // explicit: the pty makes isTTY true anyway, but say so
      COTAL_CODEX_CONFIG: JSON.stringify({ sandbox_mode: '"read-only"', model_reasoning_effort: '"low"' }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  driver.stdout!.setEncoding("utf8");
  driver.stderr!.setEncoding("utf8");
  driver.stdout!.on("data", (d: string) => (driverOut += d));
  driver.stderr!.on("data", (d: string) => (driverOut += d));

  for (let i = 0; i < 900 && !online; i++) await sleep(100);
  check("codex host peer comes online with the TUI attached", online);
  await sleep(1000);
  check("the real Codex TUI painted on the pty", /DRIVER: typed the message/.test(driverOut) || driverOut.length > 200, driverOut.slice(-400));

  for (let i = 0; i < 3000 && !/TUIPONG/i.test(reply); i++) await sleep(100);
  check(
    "a turn TYPED INTO THE TUI can call cotal_* (reply arrived over the mesh)",
    /TUIPONG/i.test(reply),
    { reply: reply.trim(), tail: driverOut.slice(-600) },
  );

  console.log(`\nCODEX TUI LIVE E2E PASSED ✅  (${pass} checks)  reply=${JSON.stringify(reply.trim())}`);
} finally {
  if (driver) {
    driver.kill("SIGTERM");
    await Promise.race([once(driver, "exit"), sleep(10_000)]);
  }
  await Promise.race([operator.stop().catch(() => {}), sleep(3_000)]);
  nats.kill("SIGKILL");
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
