/**
 * `cotal up` refuses an invalid flag value or combination as usage, exit 1, before anything runs.
 * `--max-sessions 0`, `--max-sessions abc` and an unknown `--restore-only` value used to exit 3,
 * "Outcome unconfirmed", which tells a script the run may have had an effect. `--dry-run` without
 * `-f` used to start a real stack. A non-positive `--max-file-store` is refused the same way, as is a `--max-payload` that is
 * not a byte count nats-server starts on, one below the manager start floor, one below the caller floor beside `--service-endpoints`,
 * and one passed to the open broker configuration, which renders no payload limit. An
 * `--account-resolver` other than memory or full refuses too, and so does one passed to the open
 * broker configuration, which has no accounts to resolve. `--max-file-store` beside `-f`, and
 * `--rotate-sys` on an open mesh or open manifest, refuse with the flag to drop.
 *
 * The same holds where `up` would otherwise start something it cannot stand behind. A prepared root
 * given an option the controller stack has no route for refuses UNSUPPORTED instead of starting the
 * legacy launcher, while a stopped root that launcher registered with no prepared record keeps it for
 * that option. A broker address another program holds refuses CONFLICT instead of launching a
 * broker that exits on its bind. `up -f` on a root that holds a controller stack refuses CONFLICT
 * instead of starting a manifest stack beside it. An empty `--store-dir`, which used to open the
 * default store, and one that starts with a `~` no shell expanded, which made a folder named `~`,
 * refuse USAGE_INVALID on `up` and `clean`, the second naming the absolute path. An empty or blank
 * `--runtime`, which used to start the stack on the default runtime, refuses USAGE_INVALID too.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME, from empty
 * folders outside them. Nothing is started; each refusal comes from validation. A `--server` that no
 * local broker can serve, a host name included, is refused the same way in an unprepared and a
 * prepared folder, as the short classified report with an example on the port passed. In the home
 * folder, whose `.cotal` holds the machine's own records, `up` refuses CONFLICT and writes nothing
 * there, and `down` and `down --dry-run` there find no stack. A fresh folder under the home makes its
 * own `.cotal` on a bare `up`, and removes it when a later check refuses, under a home that holds a
 * stack as well, leaving that home's records as they were, while `up -f` there refuses CONFLICT and
 * writes nothing. On an 80-column terminal the stderr note that names that `.cotal` wraps at spaces
 * to stderr's width, each line dimmed on its own, and with stderr in a file it is one line there even
 * when stdout is a terminal. A bare `up` in a new project
 * names its space after the folder: two sibling folders get their own names, `--space` and a project
 * above the folder keep theirs, and a folder name that is no valid space name, a name another folder
 * holds, or a selection whose folder was moved refuses before anything is written. A bare `up` whose
 * folder names a space that runs from another folder refuses CONFLICT naming `cotal up --space <name>`
 * and the `cotal down` in that folder. In a prepared folder whose broker store
 * this account cannot write, `up` refuses PERMISSION_DENIED naming the store and the `chmod` that
 * fixes it, where the broker used to exit naming the cause only in its log, and status names the same
 * step in place of `cotal up`. A `server.conf` that is a symlink, and a trust record this account
 * cannot read, are refused PERMISSION_DENIED the same way, each naming its path and its step. Every broker address the cells after
 * those use is held by a loopback listener that never answers NATS, so a regression still cannot
 * start a broker there. On Linux, two cells hold one by a client connection's local end instead,
 * open and then in TIME-WAIT, with nothing listening, and need the refusal to say which.
 * A refusal that names the whole fix, such as a nats:// address where the root's recorded policy or
 * --tls-cert serves TLS, prints no help after it. Those cells need `openssl` on PATH. `up -f` binds a
 * single broker address, so a `broker.servers` or `--server` that lists two URLs refuses USAGE_INVALID
 * with its fix and names neither address, where it used to fail with a bare `Invalid URL`. A listed
 * entry with credentials keeps its own refusal, and `topology view` still reads the list.
 *
 * Run: pnpm smoke:up-usage-refusal
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { clean, ptySpawn } from "./_console-pty.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; target?: { root?: string; space?: string; heldBy?: string; preparedRoot?: string }; error?: { code?: string; message?: string; remedy?: string }; result?: { kind?: string; lifetimeRequest?: string; brokerCandidate?: string; effectAttempted?: boolean; persisted?: boolean } }
const { readStackJournal, writeStackJournal } = await import("../src/lib/stack-journal.js");

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-up-usage-home-"));
const folder = mkdtempSync(join(tmpdir(), "cotal-up-usage-cwd-"));
const roots = ["unprepared", "journal"].map((name) => realpathSync(mkdtempSync(join(tmpdir(), `cotal-up-usage-${name}-`))));
const [unprepared, journalRoot] = roots as [string, string];
process.on("exit", () => { for (const dir of [home, folder, ...roots]) rmSync(dir, { recursive: true, force: true }); });

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
const anchors = new Map<string, SmokeSandboxAnchor>();
/** Record `at`, which already holds its `.cotal`, as a root a down may run in. */
const sandbox = (at: string) => anchors.set(at, recordSmokeSandbox({ root: at, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME }));
const run = (args: string[], cwd = folder, childEnv: NodeJS.ProcessEnv = env) => {
  assertSmokeSandboxDown(anchors.get(cwd), args, { cwd, env: childEnv });
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: childEnv, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 900) });

{
  const project = mkdtempSync(join(tmpdir(), "cotal-up-remedy-"));
  process.on("exit", () => rmSync(project, { recursive: true, force: true }));
  const manifest = "plan's notes.yaml";
  writeFileSync(join(project, manifest), "apiVersion: cotal/v1\nkind: Mesh\nspace: remedy-check\nbroker: { auth: false }\nchannels: {}\n");
  const refusal = run(["up", `-f=${manifest}`, "--dry-run", "--json"], project);
  const remedy = refusal.envelope?.error?.remedy ?? "";
  const value = process.platform === "win32" ? `"${manifest}"` : "'plan'\\''s notes.yaml'";
  check("a short option with an attached value names both copyable corrections", refusal.status === 1
    && refusal.envelope?.error?.code === "USAGE_INVALID" && remedy === `write -f ${value} or --file=${value}`, shown(refusal));
  for (const flags of remedy.slice(6).split(" or ")) {
    const command = `"${process.execPath}" "${BIN}" up ${flags} --dry-run`;
    const pasted = spawnSync(command, { shell: true, cwd: project, env, encoding: "utf8", timeout: 60_000 });
    check(`pasting ${flags} displays the manifest plan`, pasted.status === 0 && pasted.stdout.includes("remedy-check"), pasted.stderr);
  }
}

const cases: { args: string[]; message: RegExp }[] = [
  { args: ["--file", ""], message: /--file is empty, so it names no manifest/ },
  { args: ["-f", "  "], message: /--file is empty, so it names no manifest/ },
  { args: ["-d", "--foreground"], message: /choose --foreground or --detach, not both/ },
  { args: ["--max-sessions", "0"], message: /--max-sessions must be a positive integer/ },
  { args: ["--max-sessions", "abc"], message: /--max-sessions must be a positive integer/ },
  { args: ["--max-file-store", "0"], message: /--max-file-store must be a positive integer/ },
  { args: ["--max-payload", "0"], message: /--max-payload must be a positive integer/ },
  { args: ["--max-payload", "67108865"], message: /--max-payload 67108865 is over 67108864 bytes \(64 MiB\), which nats-server refuses to start on/ },
  { args: ["--max-payload", "263167"], message: /--max-payload 263167 is below 263168 bytes, the least the space's manager starts on/ },
  { args: ["--max-payload", "1048576", "--user-auth", "--service-endpoints"], message: /--max-payload 1048576 is below 2098176 bytes, the least a space with --service-endpoints starts on/ },
  { args: ["--account-resolver", "cache"], message: /--account-resolver takes memory or full \(got "cache"\)/ },
  { args: ["--account-resolver", "full", "--open"], message: /--account-resolver sets how the broker resolves space accounts, and the open broker configuration has none/ },
  { args: ["--restore", join(folder, "nonexistent"), "--restore-only", "full"], message: /--restore-only takes registry/ },
  { args: ["--restore-only", "registry"], message: /require --restore/ },
  // Without -f there is no plan to print, and the launch used to start a real stack.
  { args: ["--dry-run"], message: /--dry-run previews a manifest launch and needs -f/ },
  { args: ["--server", "nats://127.0.0.1:1", "--dry-run"], message: /--dry-run previews a manifest launch and needs -f/ },
];
for (const { args, message } of cases) {
  const json = run(["up", ...args, "--json"]);
  check(`up ${args.join(" ")} --json is one USAGE_INVALID refusal, exit 1`, json.status === 1 && json.envelope?.outcome === "refused" && json.envelope.error?.code === "USAGE_INVALID" && message.test(json.envelope.error.message ?? ""), shown(json));
  const text = run(["up", ...args]);
  check(`up ${args.join(" ")} prints the error and the help on stderr, nothing on stdout, exit 1`, text.status === 1 && text.stdout === "" && message.test(text.stderr) && /Usage/.test(text.stderr), shown(text));
}

// A flag the launch cannot honor is a usage refusal with its fix, exit 1. These were plain errors,
// reported as an unconfirmed outcome with exit 3. A manifest's own openness is checked after the
// structured-output refusal of `up -f`, so that case is read in text only. Without -f the run
// resolves this folder's space first, so the refusal is followed by the help, as a parser error is.
{
  const manifests = mkdtempSync(join(tmpdir(), "cotal-up-usage-manifests-"));
  process.on("exit", () => rmSync(manifests, { recursive: true, force: true }));
  const authManifest = join(manifests, "cotal.yaml"), openManifest = join(manifests, "open.yaml");
  writeFileSync(authManifest, "apiVersion: cotal/v1\nkind: Mesh\nspace: flagaudit\nchannels: {}\n");
  writeFileSync(openManifest, "apiVersion: cotal/v1\nkind: Mesh\nspace: flagauditopen\nbroker:\n  auth: false\nchannels: {}\n");
  for (const flags of [[], ["--json"], ["--plain"]]) {
    const refused = run(["up", "--dry-run", ...flags]);
    const remedy = refused.envelope?.error?.remedy ?? refused.stderr;
    const retryFlags = flags.filter((flag) => !remedy.includes(`omit ${flag}`));
    const preview = run(["up", "--dry-run", "-f", openManifest, ...retryFlags]);
    check(`missing-manifest advice with ${flags[0] ?? "default output"} leads to a read-only plan`,
      refused.status === 1 && remedy.includes("pass -f <cotal.yaml>") && (flags.length > 0 || !remedy.includes("and omit --"))
        && preview.status === 0 && preview.stdout.includes("flagauditopen") && readdirSync(folder).length === 0, shown(preview));

    const foreground = run(["up", "--foreground", "--dry-run", ...flags], manifests);
    const advice = foreground.envelope?.error?.remedy ?? foreground.stderr;
    const command = `team boot cotal.yaml --foreground --dry-run${flags.length ? ` ${flags[0]}` : ""}`;
    check(`foreground dry-run with ${flags[0] ?? "default output"} points directly to team boot`,
      foreground.status === 1 && (flags[0] !== "--json" || foreground.envelope?.error?.code === "USAGE_INVALID")
        && (flags[0] === "--json" ? ["cotal"] : ["cotal", "pnpm cotal"]).some((cli) => advice.includes(`\`${cli} ${command}\``))
        && !advice.includes("pass -f <cotal.yaml>") && !existsSync(join(manifests, ".cotal")), shown(foreground));
    const foregroundPreview = run(command.split(" "), manifests);
    check(`the foreground retry with ${flags[0] ?? "default output"} previews terminal custody without writes`,
      foregroundPreview.status === 0 && (foregroundPreview.envelope?.result?.lifetimeRequest === "terminal-bound"
        || /Lifetime request:\s+terminal-bound/.test(foregroundPreview.stdout))
        && !existsSync(join(manifests, ".cotal")), shown(foregroundPreview));
  }
  writeFileSync(join(manifests, "-mesh.yaml"), readFileSync(openManifest));
  for (const flags of [[], ["--json"], ["--plain"]]) {
    const refusal = run(["up", "--file=-mesh.yaml", "--dry-run", "--foreground", ...flags], manifests);
    const advice = refusal.envelope?.error?.remedy ?? refusal.stderr;
    const command = /preview with `((?:pnpm )?cotal) ([^`]+)`/.exec(advice);
    const expected = ["team", "boot", "./-mesh.yaml", "--foreground", "--dry-run", ...flags].join(" ");
    const retry = command?.[2] === expected ? run(command[2].split(" "), manifests) : undefined;
    const result = retry?.envelope?.result;
    const json = flags[0] === "--json";
    check(`the printed foreground retry with ${flags[0] ?? "default output"} previews a dash-leading manifest without writes`,
      refusal.status === 2 && retry?.status === 0 && retry.stderr === "" && !existsSync(join(manifests, ".cotal"))
        && (json ? command?.[1] === "cotal" && refusal.stderr === "" && refusal.envelope?.error?.code === "UNSUPPORTED"
          && retry.envelope?.outcome === "ok" && result?.kind === "fresh-team-boot-preview"
          && result.lifetimeRequest === "terminal-bound" && result.effectAttempted === false && result.persisted === false
          : /Lifetime request:\s+terminal-bound/.test(retry.stdout)),
      { refusal: shown(refusal), retry: retry && shown(retry) });
  }
  const originalServer = "nats://127.0.0.1:1";
  const server = `nats://127.0.0.1:${await freePort()}`;
  const manifest = readFileSync(openManifest, "utf8").replace("  auth: false\n", `  auth: false\n  servers: ${originalServer}\n`);
  const original = "team.yaml", copy = "team-copy.yaml";
  writeFileSync(join(manifests, original), manifest);
  writeFileSync(join(manifests, copy), manifest.replace(originalServer, server));
  for (const flags of [[], ["--json"], ["--plain"]]) {
    const refusal = run(["up", "-f", original, "--server", server, "--foreground", "--dry-run", ...flags], manifests);
    const advice = refusal.envelope?.error?.remedy ?? refusal.stderr;
    const preview = ["team", "boot", "<manifest-copy>", "--foreground", "--dry-run", ...flags];
    const json = flags[0] === "--json";
    const command = /`((?:pnpm )?cotal) (team boot [^`]+)`/.exec(advice);
    const retry = command?.[2] === preview.join(" ") && (!json || command[1] === "cotal")
      ? run(preview.map((word) => word === "<manifest-copy>" ? copy : word), manifests) : undefined;
    const result = retry?.envelope?.result;
    const correctPreview = json ? result?.brokerCandidate === server && result.lifetimeRequest === "terminal-bound"
      : retry !== undefined && /Lifetime request:\s+terminal-bound/.test(retry.stdout)
        && retry.stdout.split("\n").some((line) => line.trim().startsWith("Broker candidate:") && line.trimEnd().endsWith(` ${server}`));
    check(`foreground preview with --server and ${flags[0] ?? "default output"} inspects the broker from the manifest copy`,
      refusal.status === 2 && (json ? refusal.envelope?.error?.code === "UNSUPPORTED" : /Code:\s+UNSUPPORTED/.test(refusal.stderr))
        && advice.includes("copy the manifest") && advice.includes("`broker.servers`") && advice.includes("`--server`")
        && !advice.includes(`team boot ${original}`) && !advice.includes(server) && retry?.status === 0 && retry.stderr === "" && correctPreview
        && readFileSync(join(manifests, original), "utf8") === manifest && !existsSync(join(manifests, ".cotal")),
      { refusal: shown(refusal), retry: retry && shown(retry) });
  }
  for (const { label, args, json, help, message, remedy } of [
    { label: "-f --dry-run --max-file-store", args: ["-f", authManifest, "--dry-run", "--max-file-store", "1073741824"], json: true, help: false,
      message: "--max-file-store cannot be combined with --file/-f: a manifest launch does not render a store cap, so nothing was started", remedy: "drop --max-file-store, or start the mesh without -f" },
    { label: "--open --rotate-sys", args: ["--open", "--rotate-sys"], json: true, help: true,
      message: "--rotate-sys is for auth meshes: an open mesh (--open) has no system account or $SYS credentials to rotate, so nothing was started", remedy: "drop --rotate-sys, or drop --open to rotate an auth mesh's system account" },
    { label: "-f <open manifest> --dry-run --rotate-sys", args: ["-f", openManifest, "--dry-run", "--rotate-sys"], json: false, help: false,
      message: "--rotate-sys is for auth meshes: this manifest sets broker.auth: false (open), so there is no system account or $SYS credentials to rotate, and nothing was started", remedy: "drop --rotate-sys for this open manifest" },
  ]) {
    if (json) {
      const structured = run(["up", ...args, "--json"]);
      check(`up ${label} --json is one USAGE_INVALID refusal, exit 1, with its fix`,
        structured.status === 1 && structured.envelope?.outcome === "refused" && structured.envelope.error?.code === "USAGE_INVALID" && structured.envelope.error.message === message && structured.envelope.error.remedy === remedy, shown(structured));
    }
    const text = run(["up", ...args]);
    check(`up ${label} refuses on stderr with its fix${help ? " and the help" : " and no help"}, exit 1, not as an unconfirmed outcome`,
      text.status === 1 && text.stdout === "" && text.stderr.includes(message) && text.stderr.includes(remedy) && /Usage/.test(text.stderr) === help && !text.stderr.includes("OPERATION_UNKNOWN"), shown(text));
  }
}

for (const [flag, value] of [
  ["--service-endpoints"], ["--exchange-public-port", "43033"],
  ["--exchange-public-url", "https://example.test"], ["--exchange-trusted-proxy"],
  ["--advertised-server", "nats://127.0.0.1:43033"], ["--agent-provisioning-url", "https://example.test"],
] as const) {
  const result = run(["up", "--open", flag, ...(value === undefined ? [] : [value]), "--space", "flags-audit", "--server", "nats://127.0.0.1:43034", "--json"]);
  const error = result.envelope?.error;
  check(`up --open ${flag} refuses USAGE_INVALID before writing project state`,
    result.status === 1 && result.envelope?.outcome === "refused" && error?.code === "USAGE_INVALID"
      && error.message === `${flag} can only be used with user auth. Nothing started.`
      && error.remedy?.includes("--user-auth instead of --open") === true && !existsSync(join(folder, ".cotal")), shown(result));
}

for (const port of ["nope", "", "-1", "1.5", "65536"]) {
  const result = run(["up", "--user-auth", "--no-manager", "--space", "bad-exchange", "--exchange-public-port", port, "--json"]);
  check(`up refuses exchange port ${JSON.stringify(port)} before touching the project`,
    result.status === 1 && result.envelope?.error?.code === "USAGE_INVALID"
      && result.envelope.error.message?.includes("--exchange-public-port must be a whole number from 0 to 65535") === true
      && !existsSync(join(folder, ".cotal")), shown(result));
}

// First-enable user auth must not leave static signing authority on any startup route.
for (const route of ["foreground", "detach", "prepared", "manifest"] as const) {
  for (const idp of [undefined, "not-an-idp", "https://user:secret@example.com/auth"]) {
    const project = mkdtempSync(join(tmpdir(), "cotal-up-idp-"));
    process.on("exit", () => rmSync(project, { recursive: true, force: true }));
    chmodSync(project, 0o700);
    const space = `idp-${randomUUID().slice(0, 8)}`;
    if (route === "prepared") run(["space", "create", space, "--root", project]);
    const control = join(project, ".cotal");
    const before = existsSync(control) ? readdirSync(control, { recursive: true }).sort() : [];
    const args = ["up", "--no-manager", "--server", "nats://127.0.0.1:21800"];
    if (route === "manifest") {
      const manifest = join(project, "cotal.yaml");
      writeFileSync(manifest, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker:\n  auth: user\nchannels: {}\nagents: {}\n`);
      args.push("-f", manifest);
    } else args.push("--user-auth", "--space", space, route === "detach" ? "--detach" : "--foreground");
    if (idp !== undefined) args.push("--idp", idp);
    const result = run(args, project);
    check(`${route} user auth with ${idp === undefined ? "missing" : "invalid"} IdP refuses usage before effects`,
      result.status === 1 && /no stack was prepared|--idp is not a valid URL|--idp must not embed credentials/.test(result.stderr) && !/Outcome unconfirmed|secret/.test(result.stdout + result.stderr) && /--idp|IdP/.test(result.stderr), shown(result));
    const after = existsSync(control) ? readdirSync(control, { recursive: true }).sort() : [];
    check(`${route} IdP refusal writes no trust, credentials or store state`, JSON.stringify(after) === JSON.stringify(before), { before, after });
    if (route !== "prepared") {
      const mint = run(["auth", "mint", "audit", "--profile", "admin", "--plain"], project);
      check(`${route} refused root is not a static credential issuer`, mint.status !== 0, shown(mint));
    }
  }
}

const servers: { server: string; host?: string; message: RegExp; example: string }[] = [
  { server: "127.0.0.2:43131", host: "127.0.0.2", message: /--server is not a URL/, example: "--server nats://127.0.0.2:43131" },
  { server: "tls://broker.example:4443", host: "127.0.0.2", message: /--server names the host/, example: "--server tls://127.0.0.2:4443" },
  { server: "nats://localhost:43131", host: "0.0.0.0", message: /--server names the host/, example: "--server nats://127.0.0.1:43131" },
  { server: "http://127.0.0.1:43131", message: /--server must be a nats:\/\/ or tls:\/\/ URL/, example: "--server nats://127.0.0.1:43131" },
  { server: "nats://localhost:43131", message: /--server names the host localhost/, example: "--server nats://127.0.0.1:43131" },
  { server: "tls://broker.example:4443", message: /--server names the host broker\.example/, example: "--server tls://127.0.0.1:4443" },
  { server: "nats://127.0.0.1", message: /--server names no port/, example: "--server nats://127.0.0.1:<port>" },
  { server: "nats://127.0.0.1:43131/path", message: /--server must be one broker URL without a path, query or fragment/, example: "--server nats://127.0.0.1:43131" },
  { server: "nats://127.0.0.1:43131?a=1", message: /--server must be one broker URL without a path, query or fragment/, example: "--server nats://127.0.0.1:43131" },
  { server: "nats://127.0.0.1:43131#a", message: /--server must be one broker URL without a path, query or fragment/, example: "--server nats://127.0.0.1:43131" },
];
for (const { server, host, message, example } of servers) {
  const text = run(["up", "--server", server, ...(host ? ["--host", host] : [])]);
  check(`up --server ${server} is the classified USAGE_INVALID report with no help, exit 1, giving ${example}`, text.status === 1 && text.stdout === "" && message.test(text.stderr) && /Code:\s+USAGE_INVALID/.test(text.stderr) && text.stderr.includes(example) && !/Usage|Options/.test(text.stderr), shown(text));
}

// An empty --store-dir used to open the default store, and a ~ no shell expanded made a folder named ~.
const storeDirs = [
  { value: "", message: "--store-dir is empty; the command did not run", remedy: "name the store directory, or omit --store-dir to use the default store" },
  ...["~", "~/stores/x"].map((value) => ({ value, message: `--store-dir ${JSON.stringify(value)} starts with ~, which no shell expanded, so it names a folder called ~ in ${realpathSync(folder)}; the command did not run`, remedy: `name the absolute path: --store-dir ${join(home, value.slice(2))}` })),
];
for (const { value, message, remedy } of storeDirs) {
  const json = run(["up", "--store-dir", value, "--json"]);
  check(`up --store-dir ${JSON.stringify(value)} --json is one USAGE_INVALID refusal, exit 1, with its remedy`, json.status === 1 && json.envelope?.error?.code === "USAGE_INVALID" && json.envelope.error.message === message && json.envelope.error.remedy === remedy, shown(json));
  const clean = run(["clean", "store", "--dry-run", "--store-dir", value]);
  check(`clean store --store-dir ${JSON.stringify(value)} refuses the same way, exit 1, with no help`, clean.status === 1 && clean.stderr.includes(message) && clean.stderr.includes(remedy) && !/Usage|Options/.test(clean.stderr), shown(clean));
}

// An empty --runtime, as an unset variable gives, used to start the stack on the default runtime (#7114).
for (const value of ["", "  "]) {
  const json = run(["up", "--runtime", value, "--json"]);
  check(`up --runtime ${JSON.stringify(value)} --json is one USAGE_INVALID refusal, exit 1, with its remedy`, json.status === 1 && json.envelope?.error?.code === "USAGE_INVALID" && json.envelope.error.message === "--runtime is empty, so it names no runtime; nothing was started or written" && json.envelope.error.remedy === "name a runtime, such as `--runtime pty`, or omit --runtime to use the default", shown(json));
}

check("nothing was written in the folder", readdirSync(folder).length === 0, readdirSync(folder));

for (const flag of ["--file", "-f", "--run"]) {
  for (const value of ["", "  "]) {
    for (const mode of [["--dry-run"], ["--yes"]]) {
      const project = mkdtempSync(join(tmpdir(), "cotal-down-empty-"));
      roots.push(project);
      sandbox(project);
      const result = run(["down", flag, value, ...mode, "--json"], project);
      check(`down ${flag} ${JSON.stringify(value)} ${mode[0]} refuses usage before reading a target`, result.status === 1 && result.envelope?.error?.code === "USAGE_INVALID" && result.envelope.error.message?.includes("is empty") === true && readdirSync(join(project, ".cotal")).length === 0, shown(result));
    }
  }
}

const prepared = mkdtempSync(join(tmpdir(), "cotal-up-usage-prepared-"));
process.on("exit", () => rmSync(prepared, { recursive: true, force: true }));
const created = run(["space", "create", "upusage", "--root", prepared, "--json"]);
check("space create prepares a folder", created.status === 0, shown(created));
const issuerArgs = ["up", "--root", prepared, "--space", "upusage", "--server", "nats://127.0.0.1:1", "--user-auth", "--no-manager", "--json"];
const missingIssuer = run(issuerArgs);
check("missing issuer keeps the original start or manifest in its remedy", missingIssuer.status === 1 && missingIssuer.envelope?.error?.code === "USAGE_INVALID" && missingIssuer.envelope.error.remedy === "add `--idp <auth base URL>` to the original user-auth start. For a manifest, set `broker.idp` in the same file and retry the original command.", shown(missingIssuer));
const retryIssuer = run([...issuerArgs, "--idp", "http://127.0.0.1:1/auth"]);
check("adding only the issuer checks it for the selected project before writing a stack", retryIssuer.status === 2 && retryIssuer.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && retryIssuer.envelope.target?.root === realpathSync(prepared) && retryIssuer.envelope.target.space === "upusage" && !existsSync(join(prepared, ".cotal", "stack-controller.json")), shown(retryIssuer));
const upHelp = run(["up", "--help"]);
check("up help marks every public exchange flag as legacy user-auth only",
  ["exchange-public-port", "exchange-public-url", "exchange-trusted-proxy", "advertised-server", "agent-provisioning-url"].every((flag) =>
    new RegExp(`^  --${flag} .*legacy user-auth startup only`, "m").test(upHelp.stdout)), shown(upHelp));
const preparedExchange = run(["up", "--user-auth", "--no-manager", "--server", "nats://127.0.0.1:1", "--idp", "https://idp.example.test/auth",
  "--exchange-public-port", "0", "--exchange-public-url", "https://mesh.example.test", "--json"], prepared);
const exchangeError = preparedExchange.envelope?.error;
check("a prepared root refuses public exchange and names a route that keeps the broker, IdP and exchange flags",
  preparedExchange.status === 2 && exchangeError?.code === "UNSUPPORTED"
    && exchangeError.message?.includes("--exchange-public-port and --exchange-public-url") === true
    && exchangeError.remedy?.includes("new, unprepared project folder") === true
    && exchangeError.remedy.includes("cotal up --user-auth --idp <auth base URL>")
    && exchangeError.remedy.includes("Keep the broker and public exchange flags")
    && !existsSync(join(prepared, ".cotal", "stack-controller.json")), shown(preparedExchange));
const named = run(["up", "--server", "nats://localhost:43131", "--json"], prepared);
check("in a prepared folder a host name is the same USAGE_INVALID refusal, exit 1, naming 127.0.0.1", named.status === 1 && named.envelope?.error?.code === "USAGE_INVALID" && /names the host localhost/.test(named.envelope.error.message ?? "") && named.stdout.includes("--server nats://127.0.0.1:43131"), shown(named));
check("it wrote no stack journal", !existsSync(join(prepared, ".cotal", "stack-controller.json")), readdirSync(join(prepared, ".cotal")));
// A broker store this account cannot write is named before anything starts; the broker named it only
// in its own log. Status names the same step in place of starting the space.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const jetstream = join(prepared, ".cotal", "nats", "jetstream");
  mkdirSync(jetstream, { recursive: true, mode: 0o700 });
  chmodSync(jetstream, 0o500);
  const blocked = run(["up", "--server", "nats://127.0.0.1:1", "--json"], prepared), status = run(["status", "--json"], prepared);
  chmodSync(jetstream, 0o700);
  const step = `make it writable by you, for example with chmod -R u+w ${jetstream}`;
  check("up over a broker store it cannot write refuses PERMISSION_DENIED, exit 2, naming the store and chmod",
    blocked.status === 2 && blocked.envelope?.error?.code === "PERMISSION_DENIED" && blocked.envelope.error.message === `the broker store ${jetstream} is not writable by this account (EACCES), so the broker cannot start JetStream there; nothing was started or written` && blocked.stdout.includes(step), shown(blocked));
  check("it wrote no stack journal there either", !existsSync(join(prepared, ".cotal", "stack-controller.json")));
  const hints = (JSON.parse(status.stdout || "{}") as { result?: { hints?: string[] } }).result?.hints ?? [];
  check("status there names the store and the same step, not cotal up",
    hints.includes(`the broker store ${jetstream} is not writable by this account (EACCES), so the broker cannot start JetStream there; ${step}`) && !hints.some((hint) => hint.includes("start it with `cotal up`")), shown(status));
  // A folder this account cannot open is refused the same way, where up used to crash on it with a raw
  // EACCES stack. The store hides its jetstream then, so it is the folder named. u+w would leave it shut.
  const store = dirname(jetstream);
  for (const [closed, mode] of [[store, 0o000], [jetstream, 0o000]] as const) {
    chmodSync(closed, mode);
    const shut = run(["up", "--server", "nats://127.0.0.1:1", "--json"], prepared), shutStatus = run(["status", "--json"], prepared);
    const shutStep = `make it readable and writable by you, for example with chmod -R u+rwX ${closed}`;
    const shutHints = (JSON.parse(shutStatus.stdout || "{}") as { result?: { hints?: string[] } }).result?.hints ?? [];
    check(`up over ${closed === store ? "a store" : "a jetstream folder"} it cannot open refuses PERMISSION_DENIED, exit 2, naming it and chmod -R u+rwX, and status names the same step`,
      shut.status === 2 && shut.envelope?.error?.code === "PERMISSION_DENIED" && shut.envelope.error.message === `the broker store ${closed} is not readable or writable by this account (EACCES), so the broker cannot start JetStream there; nothing was started or written` && shut.stdout.includes(shutStep) && !shut.stderr.includes("node:fs") &&
        shutHints.some((hint) => hint.includes(shutStep)), shown(shut));
    spawnSync("chmod", ["-R", "u+rwX", closed]);
    check(`running that step verbatim opens ${closed === store ? "the store" : "the jetstream folder"} again`, (() => { try { accessSync(jetstream, constants.R_OK | constants.W_OK | constants.X_OK); return true; } catch { return false; } })());
  }
  // A root whose name a shell would split or substitute, here a backtick and a space, is quoted in the
  // step, so the step pasted into a shell changes that folder and nothing else.
  const quoteParent = mkdtempSync(join(tmpdir(), "cotal-up-usage-quote-"));
  process.on("exit", () => rmSync(quoteParent, { recursive: true, force: true }));
  const odd = join(quoteParent, "W`q d"), oddJetstream = join(odd, ".cotal", "nats", "jetstream");
  mkdirSync(odd);
  run(["space", "create", "upquote", "--root", odd, "--json"]);
  mkdirSync(oddJetstream, { recursive: true, mode: 0o700 });
  chmodSync(oddJetstream, 0o500);
  const quoted = run(["up", "--server", "nats://127.0.0.1:1", "--json"], odd);
  const command = `chmod -R u+w '${oddJetstream}'`;
  check("the step quotes a store path holding a backtick and a space",
    quoted.status === 2 && quoted.envelope?.error?.code === "PERMISSION_DENIED" && quoted.envelope.error.remedy === `make it writable by you, for example with ${command}`, shown(quoted));
  const ran = spawnSync("sh", ["-c", command], { cwd: odd, encoding: "utf8" });
  check("that step run by a shell makes the store writable", ran.status === 0 && (() => { try { accessSync(oddJetstream, constants.W_OK | constants.X_OK); return true; } catch { return false; } })(), { status: ran.status, stderr: ran.stderr });
}

// A broker configuration up cannot write, such as a symlink in its place, and a trust record it
// cannot read are each refused by name before anything starts, where up used to exit 3 saying started
// members were kept. The first refused up has already written the space's trust in this folder.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-conf-")));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  const createdConf = run(["space", "create", "upconf", "--root", root, "--json"]);
  const conf = join(root, ".cotal", "auth", "server.conf"), outside = join(root, "outside.txt");
  writeFileSync(outside, "# not a broker configuration\n");
  mkdirSync(join(root, ".cotal", "auth"), { recursive: true, mode: 0o700 });
  symlinkSync(outside, conf);
  const linked = run(["up", "--server", "nats://127.0.0.1:1", "--json"], root);
  check("up over a server.conf that is a symlink refuses PERMISSION_DENIED, exit 2, naming it and the mv that moves it aside",
    createdConf.status === 0 && linked.status === 2 && linked.envelope?.error?.code === "PERMISSION_DENIED" && (linked.envelope.error.message ?? "").includes(`the broker configuration ${conf} is a symlink, so up cannot write it`)
      && linked.envelope.error.remedy === `move it aside, as mv ${conf} ${conf}.old does, then run \`cotal up\` again, which writes it from the space's trust`, shown(linked));
  check("the link and the file it names are left as they were", lstatSync(conf).isSymbolicLink() && readFileSync(outside, "utf8") === "# not a broker configuration\n");
  const trust = join(root, ".cotal", "auth", "broker.json");
  check("rig: that up wrote the space's trust record", existsSync(trust));
  chmodSync(trust, 0o000);
  const unreadable = run(["up", "--server", "nats://127.0.0.1:1", "--json"], root);
  chmodSync(trust, 0o600);
  check("up over a trust record this account cannot read refuses PERMISSION_DENIED, exit 2, with the chmod that makes it readable",
    unreadable.status === 2 && unreadable.envelope?.error?.code === "PERMISSION_DENIED" && (unreadable.envelope.error.message ?? "").includes(`the space's trust record ${trust} cannot be read by this account (EACCES)`)
      && unreadable.envelope.error.remedy === `make it readable by you again, as chmod 600 ${trust} does, then run \`cotal up\` again; it holds the space's keys, so keep it`, shown(unreadable));
}

// Port 1 cannot be bound, so a regression here starts no usable broker.
const homeUp = run(["up", "--server", "nats://127.0.0.1:1", "--json"], home);
check("up in the home folder is one CONFLICT refusal, exit 2, naming a project folder", homeUp.status === 2 && homeUp.envelope?.error?.code === "CONFLICT" && /is your home folder/.test(homeUp.envelope.error.message ?? "") && /space create <space> --root <dir>/.test(homeUp.stdout), shown(homeUp));
check("it wrote no persona, pidfile or store in the home's .cotal", !existsSync(join(home, ".cotal", "agents")) && !existsSync(join(home, ".cotal", "nats.pid")) && !existsSync(join(home, ".cotal", "nats")), existsSync(join(home, ".cotal")) ? readdirSync(join(home, ".cotal")) : []);
// With no stack there and none started or registered on this machine, down and its preview say
// there is nothing to stop or preview, and name `cotal up` in a project as status does.
sandbox(home);
const homeDown = run(["down", "--yes"], home);
check("down --yes in a home with no stack is TARGET_NOT_FOUND, nothing to stop, and names `cotal up` in a project", homeDown.status === 2 && /there is no stack at this folder's root, and this machine has no stack started or registered, so there is nothing to stop/.test(homeDown.stderr) && /run `(?:pnpm )?cotal up` in a project/.test(homeDown.stderr), shown(homeDown));
const homePreview = run(["down", "--dry-run", "--json"], home);
check("down --dry-run in a home with no stack is TARGET_NOT_FOUND, nothing to preview, and names `cotal up` in a project", homePreview.status === 2 && homePreview.envelope?.error?.code === "TARGET_NOT_FOUND" && /no stack started or registered, so there is nothing to preview/.test(homePreview.envelope.error.message ?? "") && /^run `(?:pnpm )?cotal up` in a project$/.test(homePreview.envelope.error.remedy ?? ""), shown(homePreview));

// A fresh folder under the home, whose only .cotal above it is the home's, becomes its own project
// root on a bare up, also under a home that holds a stack. A run refused before it writes there leaves
// the folder as it was. A manifest start there still needs a prepared folder.
if (process.platform !== "win32") {
  mkdirSync(join(home, ".cotal"), { recursive: true, mode: 0o700 });
  const nested = join(home, "Desktop", "fresh");
  mkdirSync(nested, { recursive: true, mode: 0o755 });
  const nestedRecords = join(realpathSync(nested), ".cotal");
  const homeWrites = () => ["agents", "nats", "auth"].filter((name) => existsSync(join(home, ".cotal", name)));
  const runtimeUp = run(["up", "--runtime", "nosuch", "--server", "nats://127.0.0.1:1"], nested);
  check("a bare up in a fresh folder under the home makes the folder's own .cotal and reaches its own checks", runtimeUp.status === 2 && /Code:\s+DEPENDENCY_UNAVAILABLE/.test(runtimeUp.stderr) && runtimeUp.stderr.includes(`made ${nestedRecords} for this folder's records; the machine's home .cotal was not used`), shown(runtimeUp));
  check("that refused up removed the .cotal it made and wrote nothing in the home's", !existsSync(nestedRecords) && homeWrites().length === 0, homeWrites());
  const inherited = "this folder inherits the machine's home .cotal; up did not start a stack in that home root";
  const prepare = "prepare this folder with `cotal space create <space> --root .`, then repeat your manifest command from this folder";
  for (const flag of ["", "--plain", "--json"]) {
    const manifestUp = run(["up", "-f", "cotal.yaml", ...(flag ? [flag] : [])], nested);
    const remedy = prepare + (flag ? `, but omit ${flag}` : "");
    const correct = flag === "--json" ? manifestUp.envelope?.error?.code === "CONFLICT" && manifestUp.envelope.error.message === inherited && manifestUp.envelope.error.remedy === remedy
      : manifestUp.stderr.includes(inherited) && manifestUp.stderr.includes(remedy) && (flag !== "" || !manifestUp.stderr.includes(", but omit"));
    check(`up -f under the home with ${flag || "default output"} keeps the manifest in its retry and writes nothing`, manifestUp.status === 2 && correct && !existsSync(nestedRecords), shown(manifestUp));
  }
  const { displayWidth, findMesh, recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  // On an 80-column terminal the note wraps at spaces to stderr's width, each line dimmed on its own.
  // `redirect` sends one stream to a file, so stdout and stderr can be told apart.
  const made = `made ${nestedRecords} for this folder's records; the machine's home .cotal was not used`;
  const streamFile = join(folder, "redirected.txt");
  const onTerminal = async (redirect: string, extra: NodeJS.ProcessEnv) => {
    rmSync(streamFile, { force: true });
    let raw = "";
    const pty = ptySpawn("/bin/sh", ["-c", `exec "$0" "$@" ${redirect}`, process.execPath, BIN, "up", "--runtime", "nosuch", "--server", "nats://127.0.0.1:1"], { name: "xterm-256color", cols: 80, rows: 200, cwd: nested, env: { ...extra, REDIRECTED: streamFile } as Record<string, string> });
    pty.onData((data) => { raw += data; });
    const exit = await new Promise<number>((done) => pty.onExit((e) => done(e.exitCode)));
    return { exit, raw: raw.split(/\r?\n/), lines: clean(raw).split(/\r?\n/), file: existsSync(streamFile) ? readFileSync(streamFile, "utf8") : "" };
  };
  /** The note's lines, from the first one, until they read as the note again. */
  const noteLines = (lines: string[]): string[] => {
    const block: string[] = [];
    if (lines[0]?.startsWith("made")) for (const line of lines) { block.push(line); if (block.join(" ").length >= made.length) break; }
    return block;
  };
  const wraps = (block: string[]) => block.length > 1 && block.join(" ") === made && block.every((l) => displayWidth(l) <= 80 || !l.includes(" "));
  const colored = await onTerminal("", Object.fromEntries(Object.entries(env).filter(([k]) => k !== "NO_COLOR")));
  const coloredNote = noteLines(colored.lines);
  check("on an 80-column terminal the note comes first and wraps at spaces within 80 columns, the rest of the run unchanged", colored.exit === 2 && wraps(coloredNote) && colored.lines.some((l) => /Code:\s+DEPENDENCY_UNAVAILABLE/.test(l)) && !existsSync(nestedRecords), colored.lines);
  check("...each of its lines dimmed on its own", coloredNote.every((l, i) => colored.raw[i] === `\x1b[2m${l}\x1b[0m`), colored.raw.slice(0, coloredNote.length));
  const stdoutFiled = await onTerminal(`>"$REDIRECTED"`, env);
  check("with stdout in a file and stderr on the terminal, the note still wraps there within 80 columns", stdoutFiled.exit === 2 && wraps(noteLines(stdoutFiled.lines)) && !stdoutFiled.file.includes("made"), stdoutFiled.lines);
  const stderrFiled = await onTerminal(`2>"$REDIRECTED"`, env);
  check("with stderr in a file and stdout on the terminal, the note is one exact line there", stderrFiled.exit === 2 && stderrFiled.file.split("\n")[0] === made && !stderrFiled.lines.some((l) => l.includes("made")), { lines: stderrFiled.lines, file: stderrFiled.file.slice(0, 900) });
  process.env.COTAL_HOME = join(home, ".cotal");
  recordMesh({ space: "homestack", server: "nats://127.0.0.1:1", root: home, mode: "auth", ts: new Date().toISOString() });
  const homeEntry = JSON.stringify(findMesh("homestack"));
  const wrongFolder = join(folder, "not-the-stack");
  mkdirSync(join(wrongFolder, ".cotal"), { recursive: true });
  sandbox(wrongFolder);
  for (const option of ["--yes", "--dry-run"]) {
    const misplaced = run(["down", option, "--with-agents", "--json"], wrongFolder);
    check(`a wrong-folder down with ${option} asks to repeat the original options in the owning folder`, misplaced.status === 2 && misplaced.envelope?.error?.code === "TARGET_NOT_FOUND" && misplaced.envelope.error.remedy?.includes("repeat your original command from the folder") && !existsSync(join(wrongFolder, ".cotal", "stack-controller.json")), shown(misplaced));
  }
  const holdsUp = run(["up", "--runtime", "nosuch", "--server", "nats://127.0.0.1:1", "--json"], nested);
  const holdsManifest = run(["up", "-f", "cotal.yaml", "--json"], nested);
  const homeAfter = JSON.stringify(findMesh("homestack"));
  removeMesh("homestack");
  delete process.env.COTAL_HOME;
  check("under a home that holds a stack, a bare up there starts the folder's own space and reaches its own checks",
    holdsUp.status === 2 && holdsUp.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && holdsUp.envelope.target?.space === "fresh" && holdsUp.envelope.target.root === realpathSync(nested), shown(holdsUp));
  check("it removed the .cotal it made and left the home's registration and records as they were", !existsSync(nestedRecords) && homeAfter === homeEntry && homeWrites().length === 0, { homeEntry, homeAfter, writes: homeWrites() });
  check("up -f there still refuses CONFLICT the same way", holdsManifest.status === 2 && holdsManifest.envelope?.error?.code === "CONFLICT" && holdsManifest.envelope.error.message === inherited && holdsManifest.envelope.error.remedy === `${prepare}, but omit --json` && !existsSync(nestedRecords), shown(holdsManifest));
}

// A bare up in a new project names its space after the folder. `--runtime nosuch` stops each start
// at its runtime check, after the space is resolved and before anything is started.
if (process.platform !== "win32") {
  const desktop = realpathSync(join(home, "Desktop"));
  const project = (...names: string[]) => { const dir = join(desktop, ...names); mkdirSync(dir, { recursive: true, mode: 0o755 }); return dir; };
  const records = (dir: string) => existsSync(join(dir, ".cotal"));
  const probe = ["--runtime", "nosuch", "--server", "nats://127.0.0.1:1", "--json"];
  const resolved = (r: ReturnType<typeof run>, space: string) => r.status === 2 && r.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && r.envelope.target?.space === space;
  const named = "up names a new project's space after its folder, and";
  for (const name of ["alpha", "beta"]) {
    const dir = project(name);
    const sibling = run(["up", ...probe], dir);
    check(`a bare up in the sibling folder ${name} starts the space ${name} and leaves the folder as it was when refused`, resolved(sibling, name) && !records(dir), shown(sibling));
  }
  const spaced = project("My Project");
  const invalid = run(["up", "--server", "nats://127.0.0.1:1", "--json"], spaced);
  const prepareNamed = "for a controller-supported start, prepare this folder with `cotal space create <name> --root .` using a valid unused name, then repeat your startup command with the same options; for native startup, add `--space <name>` and omit the output flag instead";
  check("an invalid folder name refuses without writes and names the preparation needed to keep JSON output",
    invalid.status === 1 && invalid.envelope?.error?.code === "USAGE_INVALID" && invalid.envelope.target?.space === undefined && invalid.envelope.error.remedy === prepareNamed
      && invalid.envelope.error.message === `${named} the folder name "My Project" cannot be one: a space name is 1 to 64 letters, digits, underscores or hyphens, which \`cotal up\` needs to start it; nothing was started or written` && !records(spaced), shown(invalid));
  const invalidText = run(["up", "--server", "nats://127.0.0.1:1"], spaced);
  check("the text remedy adds the space without discarding the requested server", invalidText.status === 1 && invalidText.stdout === ""
    && invalidText.stderr === `✗ ${invalid.envelope?.error?.message}\n  repeat your startup command with the same options, adding \`--space <name>\` with a valid unused name\n` && !records(spaced), shown(invalidText));
  const invalidPlain = run(["up", "--server", "nats://127.0.0.1:1", "--plain"], spaced);
  check("plain output also directs the caller to prepare the same folder", invalidPlain.status === 1 && `${invalidPlain.stdout}${invalidPlain.stderr}`.includes(prepareNamed) && !records(spaced), shown(invalidPlain));
  const override = run(["up", "--space", "custom", ...probe], spaced);
  check("--space names the space there", resolved(override, "custom") && !records(spaced), shown(override));
  for (const space of ["bad space", "café", "a.b"]) {
    const explicit = run(["up", "--open", "--foreground", "--space", space, "--runtime", "nosuch", "--server", "nats://127.0.0.1:1"], spaced);
    check(`up refuses explicit space ${JSON.stringify(space)} before startup or writes`,
      explicit.status === 1 && explicit.stdout === "" && /nothing was started or written/.test(explicit.stderr) &&
        explicit.stderr.includes("choose a name of only letters, digits, underscores and hyphens") && !records(spaced), shown(explicit));
  }
  const { recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  process.env.COTAL_HOME = join(home, ".cotal");
  const gammaRoot = realpathSync(folder);
  recordMesh({ space: "gamma", server: "nats://127.0.0.1:1", root: gammaRoot, mode: "auth", ts: new Date().toISOString() });
  const registered = run(["up", "--server", "nats://127.0.0.1:1", "--json"], project("gamma"));
  removeMesh("gamma");
  delete process.env.COTAL_HOME;
  check("a folder name another folder registered refuses CONFLICT, exit 2, naming --space, and writes nothing",
    registered.status === 2 && registered.envelope?.error?.code === "CONFLICT" && registered.envelope.target?.heldBy === gammaRoot
      && registered.envelope.error.message === `${named} "gamma" is already registered at nats://127.0.0.1:1 for ${gammaRoot}; nothing was started or written`
      && registered.envelope.error.remedy === "name this folder's space with `cotal up --space <name>`, naming one this machine does not use; `cotal space` lists the names in use" && !records(join(desktop, "gamma")), shown(registered));
  const deltaHome = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-delta-")));
  process.on("exit", () => rmSync(deltaHome, { recursive: true, force: true }));
  const preparedDelta = run(["space", "create", "delta", "--root", "."], deltaHome);
  const prepared = run(["up", "--server", "nats://127.0.0.1:1", "--json"], project("delta"));
  check("a folder name another folder prepared refuses CONFLICT the same way and writes nothing",
    preparedDelta.status === 0 && prepared.status === 2 && prepared.envelope?.error?.code === "CONFLICT" && prepared.envelope.error.message === `${named} "delta" is already prepared for ${deltaHome}; nothing was started or written` && !records(join(desktop, "delta")), shown(prepared));
  const ancestor = project("proj");
  const preparedProj = run(["space", "create", "projspace", "--root", "."], ancestor);
  const below = run(["up", ...probe], project("proj", "sub"));
  check("in a folder of a prepared project, a bare up runs that project's space and writes nothing in the folder",
    preparedProj.status === 0 && resolved(below, "projspace") && below.envelope?.target?.root === ancestor && !records(join(ancestor, "sub")), shown(below));
  const source = project("moved");
  const preparedMoved = run(["space", "create", "moved", "--root", "."], source);
  const selected = run(["use", "moved"], source);
  rmSync(source, { recursive: true });
  const afterMove = run(["up", "--server", "nats://127.0.0.1:1", "--json"], project("epsilon"));
  check("while the selected space's folder no longer exists, a bare up refuses TARGET_UNAVAILABLE and does not start the folder's name",
    preparedMoved.status === 0 && selected.status === 0 && afterMove.status === 2 && afterMove.envelope?.error?.code === "TARGET_UNAVAILABLE"
      && afterMove.envelope.error.message === `the selected space "moved" is prepared in ${source}, which no longer exists, and this folder names no space, so up did not start "epsilon" here` && !records(join(desktop, "epsilon")), shown(afterMove));
  check("recovering a moved selection keeps the requested startup options for either space",
    afterMove.envelope?.error?.remedy === 'restore the original project folder at its recorded path, then repeat your startup command in that folder; to start "epsilon" here instead, add `--space epsilon` to your original command', shown(afterMove));
  const blockedStart = () => run(["up", "--server", "nats://127.0.0.1:1", "--json"], join(desktop, "epsilon"));
  writeFileSync(source, "obstruction");
  const blocked = blockedStart();
  check("a file at the selection's project path refuses startup before preparing another space",
    blocked.status === 2 && blocked.envelope?.error?.code === "TARGET_UNAVAILABLE" && blocked.envelope.target?.preparedRoot === source
      && blocked.envelope.error.message?.includes("is not a directory") === true && blocked.envelope.error.remedy?.includes("restore the original project folder") === true
      && readFileSync(source, "utf8") === "obstruction" && !records(join(desktop, "epsilon")), shown(blocked));
  rmSync(source);
  if (process.getuid?.() !== 0) {
    mkdirSync(source, { mode: 0o600 });
    try {
      const denied = blockedStart();
      check("a selection whose project cannot be entered calls for restoring access, not forgetting it",
        denied.status === 2 && denied.envelope?.error?.code === "TARGET_UNAVAILABLE" && denied.envelope.target?.preparedRoot === source
          && denied.envelope.error.remedy?.includes("restore access") === true && !denied.envelope.error.remedy.includes("forget") && !records(join(desktop, "epsilon")), shown(denied));
    } finally { chmodSync(source, 0o700); }
  }
  for (const space of ["delta", "projspace", "moved"]) run(["space", "forget", space]);
}

// A loopback listener that accepts and never answers NATS holds every broker address below.
const holder = createServer((socket) => socket.on("error", () => {}));
const held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as AddressInfo).port)));
const started = (root: string) => existsSync(join(root, ".cotal", "nats.pid"));
try {
  const seedRoot = mkdtempSync(join(tmpdir(), "cotal-up-seed-refusal-"));
  roots.push(seedRoot);
  const seedConfig = join(home, "seed-refusal-config");
  const seedDir = join(seedConfig, "cotal", "seed");
  const stamp = join(seedDir, "stamp.json");
  const generation = '{"generation":"999.0.0"}\n';
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(stamp, generation);
  const seedEnv = { ...env, XDG_CONFIG_HOME: seedConfig, COTAL_SKIP_CONNECTOR_SEED: "0", COTAL_NO_UPDATE_CHECK: "1" };
  const seedArgs = ["up", "--server", `nats://127.0.0.1:${held}`];
  const help = run([...seedArgs, "--help"], seedRoot, seedEnv);
  check("up help takes precedence over connector seed refusal", help.status === 0 && /Usage/.test(help.stdout) && help.stderr === "", shown(help));
  const invalid = run([...seedArgs, "--max-sessions", "0", "--json"], seedRoot, seedEnv);
  check("up validates arguments before checking connector seed state", invalid.status === 1
    && invalid.envelope?.error?.code === "USAGE_INVALID" && invalid.stderr === "", shown(invalid));
  for (const [flags, message] of [
    [["--no-manager"], /does not move it back to an older one/],
    [[], /this would migrate the machine-wide store/],
  ] as const) {
    const refusal = run([...seedArgs, ...flags, "--json"], seedRoot, seedEnv);
    check(`up ${flags.length ? "without" : "with"} a manager reports its connector seed refusal as JSON`,
      refusal.status === 2 && refusal.stderr === "" && refusal.envelope?.outcome === "refused"
      && refusal.envelope.error?.code === "DEPENDENCY_UNAVAILABLE" && message.test(refusal.envelope.error.message ?? ""), shown(refusal));
  }
  check("help, invalid input and seed refusals leave seed and project state intact",
    readFileSync(stamp, "utf8") === generation && readdirSync(seedDir).join() === "stamp.json" && readdirSync(seedRoot).length === 0);

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const path = join(realpathSync(prepared), ".cotal");
    const args = ["up", "--foreground", "--server", `nats://127.0.0.1:${held}`];
    const before = readdirSync(path).sort().join("\n");
    chmodSync(path, 0o600);
    try {
      const blocked = run(args, prepared);
      const command = blocked.stderr.match(/with (chmod u\+wx .+)$/m)?.[1];
      check("an owner-writable .cotal without search access refuses before startup and names a permission repair",
        blocked.status === 2 && /Code:\s+PERMISSION_DENIED/.test(blocked.stderr) && blocked.stderr.includes(`${path} does not grant this account both write and search access`) && command === `chmod u+wx ${path}`, shown(blocked));
      check("the refusal leaves .cotal without search permission", (lstatSync(path).mode & 0o777) === 0o600);
      if (command === `chmod u+wx ${path}`) {
        const repaired = spawnSync("sh", ["-c", command], { cwd: prepared, encoding: "utf8" });
        check("the printed command restores owner search access without changing project entries",
          repaired.status === 0 && (lstatSync(path).mode & 0o777) === 0o700 && readdirSync(path).sort().join("\n") === before, repaired.stderr);
      }
    } finally {
      chmodSync(path, 0o700);
    }
  }

  const emptyRestore = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-empty-restore-")));
  roots.push(emptyRestore);
  const restoreArgs = ["--open", "--no-manager", "--server", `nats://127.0.0.1:${held}`, "--space", "emptyrestore", "--restore", ""];
  const restore = run(["up", "--foreground", ...restoreArgs], emptyRestore);
  check("an explicitly empty --restore refuses foreground startup before writing project state",
    restore.status === 1 && restore.stdout === "" && restore.stderr.includes("--restore is empty") && restore.stderr.includes("pass the backup folder") && readdirSync(emptyRestore).length === 0, shown(restore));
  const restoreJson = run(["up", "--detach", ...restoreArgs, "--json"], emptyRestore);
  check("an explicitly empty --restore is USAGE_INVALID in JSON and leaves the project empty",
    restoreJson.status === 1 && restoreJson.envelope?.outcome === "refused" && restoreJson.envelope.error?.code === "USAGE_INVALID" && readdirSync(emptyRestore).length === 0, shown(restoreJson));

  // A refusal that names the address to pass is the whole fix, so no help follows it and scrolls the
  // fix away: a nats:// address where the root's recorded policy or --tls-cert serves TLS, and a
  // tls:// address with no TLS to serve.
  {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-tls-")));
    roots.push(root);
    mkdirSync(join(root, ".cotal"));
    const [cert, key] = [join(root, "c.pem"), join(root, "k.pem")];
    const minted = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
    check("openssl mints the certificate the TLS refusals are given", minted.status === 0 && existsSync(cert), { status: minted.status, stderr: minted.stderr?.slice(0, 400) });
    const policyFile = join(root, ".cotal", "broker-policy.json");
    const policy = JSON.stringify({ version: 1, transport: { kind: "tls-required", certFile: cert, keyFile: key } });
    writeFileSync(policyFile, policy);
    const plainRoot = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-plain-")));
    roots.push(plainRoot);
    mkdirSync(join(plainRoot, ".cotal"));
    for (const { label, args, cwd, message, remedy } of [
      { label: "a nats:// --server in a root whose recorded policy serves TLS", args: ["--server", `nats://127.0.0.1:${held}`], cwd: root, message: `this root serves the broker over TLS (${policyFile}), so --server must be a tls:// address`, remedy: `pass --server tls://127.0.0.1:${held}` },
      { label: "a nats:// --server with --tls-cert", args: ["--server", `nats://127.0.0.1:${held}`, "--tls-cert", cert, "--tls-key", key], cwd: plainRoot, message: "--tls-cert serves the broker over TLS, so --server must be a tls:// address", remedy: `pass --server tls://127.0.0.1:${held}` },
      { label: "a tls:// --server with no TLS configured", args: ["--server", `tls://127.0.0.1:${held}`], cwd: plainRoot, message: "--server names a tls:// address, but no TLS certificate and key are configured", remedy: "serve TLS with --tls-cert <cert.pem> --tls-key <key.pem>, or use a nats:// address" },
    ]) {
      const r = run(["up", ...args], cwd);
      check(`up refuses ${label} with its fix and no help, exit 1`, r.status === 1 && r.stdout === "" && r.stderr.includes(message) && r.stderr.includes(remedy) && !/Usage|Options/.test(r.stderr), shown(r));
    }
    check("the refusals leave the recorded policy as it was and start no broker", readFileSync(policyFile, "utf8") === policy && !started(root) && !started(plainRoot), readdirSync(join(root, ".cotal")));
  }

  // `up -f` binds a single broker address, so a list in broker.servers or --server refuses before
  // anything parses it as one URL, where it used to fail with a bare `Invalid URL` and an unknown
  // outcome. Each entry is still checked first, and topology view still reads the list. A second
  // listener holds the other address, so a regression that took either entry cannot start a broker.
  {
    const other = createServer((socket) => socket.on("error", () => {}));
    const second = await new Promise<number>((resolve) => other.listen(0, "127.0.0.1", () => resolve((other.address() as AddressInfo).port)));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-list-")));
    roots.push(project);
    const [one, list] = [`nats://127.0.0.1:${held}`, `nats://127.0.0.1:${held},nats://127.0.0.1:${second}`];
    const secret = `nats://listuser:listsecret@127.0.0.1:${second}`;
    const manifest = (servers: string) => `apiVersion: cotal/v1\nkind: Mesh\nspace: upusagelist\nbroker:\n  servers: "${servers}"\nchannels: {}\n`;
    writeFileSync(join(project, "single.yaml"), manifest(one));
    writeFileSync(join(project, "list.yaml"), manifest(list));
    writeFileSync(join(project, "secret.yaml"), manifest(`${one},${secret}`));
    const files = "list.yaml,secret.yaml,single.yaml";
    const fromFile = { message: "broker.servers lists 2 broker URLs, and up -f binds a single broker address; nothing was started or written", remedy: "set broker.servers in list.yaml to the one URL the new broker listens on" };
    const fromFlag = { message: "--server lists 2 broker URLs, and up -f binds a single broker address; nothing was started or written", remedy: "pass one --server URL for the new broker to listen on" };
    for (const { label, args, expected } of [
      { label: "a manifest whose broker.servers lists two URLs", args: ["-f", "list.yaml", "--dry-run"], expected: fromFile },
      { label: "a manifest whose broker.servers lists two URLs, applied", args: ["-f", "list.yaml"], expected: fromFile },
      { label: "a --server that lists two URLs", args: ["-f", "single.yaml", "--server", list, "--dry-run"], expected: fromFlag },
    ]) {
      const r = run(["up", ...args], project);
      check(`up ${args.join(" ")}: ${label} refuses USAGE_INVALID with its fix and no help, exit 1, naming no address`,
        r.status === 1 && r.stdout === "" && r.stderr.includes(expected.message) && r.stderr.includes(expected.remedy) && !/Invalid URL|Usage|Options/.test(r.stderr) && !r.stderr.includes(String(second)), shown(r));
    }
    for (const { label, args, message } of [
      { label: "broker.servers", args: ["-f", "secret.yaml", "--dry-run"], message: "broker.servers entry 2 must not embed credentials" },
      { label: "--server", args: ["-f", "single.yaml", "--server", `${one},${secret}`, "--dry-run"], message: "--server must not embed credentials" },
    ]) {
      const r = run(["up", ...args], project);
      check(`a list in ${label} whose second entry embeds credentials keeps that entry's refusal, exit 1, without the secret`,
        r.status === 1 && r.stderr.includes(message) && !/lists 2 broker URLs/.test(r.stderr) && !`${r.stdout}${r.stderr}`.includes("listsecret"), shown(r));
    }
    const single = run(["up", "-f", "single.yaml", "--dry-run"], project);
    check("up -f --dry-run of a manifest naming one URL still prints its plan, exit 0", single.status === 0 && single.stdout.includes(`at ${one} `) && /Dry run - nothing was changed/.test(single.stdout), shown(single));
    const override = run(["up", "-f", "list.yaml", "--server", one, "--dry-run"], project);
    check("one --server over a listed broker.servers is the address the plan binds, exit 0", override.status === 0 && override.stdout.includes(`at ${one} `), shown(override));
    const topology = run(["topology", "view", "-f", "list.yaml"], project);
    check("topology view -f still reads the listed broker.servers, exit 0", topology.status === 0 && topology.stdout.includes(`broker: ${list} `), shown(topology));
    check("the refusals wrote nothing in the project and started no broker", readdirSync(project).sort().join(",") === files && !started(project), readdirSync(project));
    other.close();
  }
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-read-")));
    roots.push(root);
    const store = join(root, ".cotal", "nats");
    run(["space", "create", "readstore", "--root", root, "--json"]);
    mkdirSync(join(store, "jetstream"), { recursive: true, mode: 0o700 });
    chmodSync(store, 0o300);
    try {
      const closed = run(["up", "--server", `nats://127.0.0.1:${held}`, "--json"], root), status = run(["status", "--json"], root);
      const step = `make it readable and writable by you, for example with chmod -R u+rwX ${store}`;
      const hints = (JSON.parse(status.stdout || "{}") as { result?: { hints?: string[] } }).result?.hints ?? [];
      check("a writable store root without read access is refused by name before a stack journal is written",
        closed.status === 2 && closed.envelope?.error?.code === "PERMISSION_DENIED" && closed.envelope.error.message === `the broker store ${store} is not readable by this account (EACCES), so the broker cannot open its store; nothing was started or written` && closed.envelope.error.remedy === step && !existsSync(join(root, ".cotal", "stack-controller.json")), shown(closed));
      check("status names the same read-access step instead of another up", hints.some((hint) => hint.includes(step)) && !hints.some((hint) => hint.includes("start it with `cotal up`")), shown(status));
    } finally { chmodSync(store, 0o700); }
  }
  const rotate = run(["up", "--server", `nats://127.0.0.1:${held}`, "--rotate-sys", "--json"], prepared);
  check("a prepared root refuses an option the controller stack has no route for, UNSUPPORTED, exit 2, naming it and why",
    rotate.status === 2 && rotate.envelope?.outcome === "refused" && rotate.envelope.error?.code === "UNSUPPORTED"
      && /prepared for a controller-owned stack, which has no route for --rotate-sys/.test(rotate.envelope.error.message ?? "") && /run `cotal up` without --rotate-sys; a first start mints the space's \$SYS creds/.test(rotate.envelope.error.remedy ?? ""), shown(rotate));
  const tls = run(["up", "--server", `tls://127.0.0.1:${held}`, "--tls-cert", join(prepared, "c.pem"), "--tls-key", join(prepared, "k.pem"), "--json"], prepared);
  const tlsRoute = /serve TLS from a manifest whose broker\.servers names a tls:\/\/ address, with `cotal up -f <cotal\.yaml> --tls-cert <cert\.pem> --tls-key <key\.pem>`/;
  check("…and names both TLS options, the tls:// address and the -f route that serves TLS", tls.status === 2 && tls.envelope?.error?.code === "UNSUPPORTED" && /no route for --tls-cert, --tls-key and --server tls:\/\//.test(tls.envelope.error.message ?? "") && tlsRoute.test(tls.envelope.error.remedy ?? ""), shown(tls));
  // Each TLS form refuses the same way first, so no refusal sends it to another form that refuses too.
  const plainTls = run(["up", "--server", `nats://127.0.0.1:${held}`, "--tls-cert", join(prepared, "c.pem"), "--tls-key", join(prepared, "k.pem"), "--json"], prepared);
  check("…a nats:// address with the TLS pair refuses that way, not by naming tls://", plainTls.status === 2 && plainTls.envelope?.error?.code === "UNSUPPORTED" && /no route for --tls-cert and --tls-key/.test(plainTls.envelope.error.message ?? "") && tlsRoute.test(plainTls.envelope.error.remedy ?? ""), shown(plainTls));
  const bareTls = run(["up", "--server", `tls://127.0.0.1:${held}`, "--json"], prepared);
  check("…and a tls:// address alone refuses that way, not by asking for --tls-cert", bareTls.status === 2 && bareTls.envelope?.error?.code === "UNSUPPORTED" && /no route for --server tls:\/\//.test(bareTls.envelope.error.message ?? "") && tlsRoute.test(bareTls.envelope.error.remedy ?? ""), shown(bareTls));
  check("…without starting the legacy launcher or the controller stack", !started(prepared) && !existsSync(join(prepared, ".cotal", "stack-controller.json")), readdirSync(join(prepared, ".cotal")));
  // A root the legacy launcher started keeps it for such an option: its `up` registered the space in
  // user mode with no prepared record, as a stack stopped without `down` leaves it. Under --json that
  // launcher refuses before it starts anything, so the message tells the two routes apart.
  {
    const legacy = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-legacy-")));
    roots.push(legacy);
    mkdirSync(join(legacy, ".cotal"), { mode: 0o700 });
    const { recordMesh, removeMesh } = await import("@cotal-ai/workspace");
    process.env.COTAL_HOME = join(home, ".cotal");
    recordMesh({ space: "legacyface", server: `nats://127.0.0.1:${held}`, root: legacy, mode: "user", origin: "up", ts: new Date().toISOString() });
    const face = run(["up", "--space", "legacyface", "--user-auth", "--idp", "https://idp.example.test/api/auth", "--server", `nats://127.0.0.1:${held}`, "--exchange-public-port", String(await freePort()), "--exchange-public-url", "https://mesh.example.test", "--json"], legacy);
    const plainUp = run(["up", "--space", "legacyface", "--user-auth", "--idp", "https://idp.example.test/api/auth", "--server", `nats://127.0.0.1:${held}`, "--json"], legacy);
    removeMesh("legacyface");
    delete process.env.COTAL_HOME;
    const launcher = /IdP did not serve usable JWKS/;
    check("a stopped legacy root checks the IdP before its public-face startup",
      face.status === 2 && face.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && launcher.test(face.envelope.error.message ?? "") && !started(legacy) && !existsSync(join(legacy, ".cotal", "stack-controller.json")), shown(face));
    check("…and ordinary user-auth startup there checks the IdP too, writing no stack journal",
      plainUp.status === 2 && plainUp.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && launcher.test(plainUp.envelope.error.message ?? "") && !started(legacy) && !existsSync(join(legacy, ".cotal", "stack-controller.json")), shown(plainUp));
  }

  const bind = run(["up", "--foreground", "--open", "--no-manager", `--server=nats://127.0.0.1:${held}`], unprepared);
  check("the legacy route refuses a held address CONFLICT, exit 2, naming the address, and launches nothing",
    bind.status === 2 && /CONFLICT/.test(bind.stderr) && new RegExp(`another process holds the broker address 127\\.0\\.0\\.1:${held}`).test(bind.stderr) && !started(unprepared), shown(bind));
  const retry = /another address with `([^`]+)`, or .* and run `([^`]+)` again/.exec(bind.stderr);
  const alternate = / up --foreground --open --no-manager --server nats:\/\/127\.0\.0\.1:(\d+)$/.exec(retry?.[1] ?? "");
  check("both busy-port retries preserve the foreground open broker-only start, with only the alternate changing the port",
    alternate !== null && Number(alternate[1]) !== held && retry?.[2]?.endsWith(` up --foreground --open --no-manager --server nats://127.0.0.1:${held}`) === true, shown(bind));

  // A port nothing listens on can still refuse the bind: an open client connection's local end holds
  // it, and after that client closes first, its TIME-WAIT holds it for up to a minute. The refusal
  // says which, and a TIME-WAIT's next step is to wait, since no process holds it. A connection on
  // another local address that shares the port number holds nothing here. Only Linux's kernel table
  // shows it.
  if (process.platform === "linux") {
    // The kernel's table prints 127.0.0.1 little-endian, plain in tcp and IPv4-mapped in tcp6.
    const states = (port: number, local = ["0100007F", "0000000000000000FFFF00000100007F"]) => ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((table) => readFileSync(table, "utf8").split("\n").slice(1))
      .map((row) => row.trim().split(/\s+/)).filter(([, at]) => at && local.includes(at.slice(0, at.lastIndexOf(":"))) && Number.parseInt(at.slice(at.lastIndexOf(":") + 1), 16) === port).map(([, , , state]) => state);
    const peer = createServer((socket) => socket.on("end", () => socket.end()).on("error", () => {}));
    const at = await new Promise<number>((resolve) => peer.listen(0, "127.0.0.1", () => resolve((peer.address() as AddressInfo).port)));
    // Linux gives an automatic port to connections bound for other destinations too, so another
    // process's open connection can share the client's and still hold it after the client closes.
    // The client keeps a port no other socket has. Binding one itself would not hold it: Node binds
    // with SO_REUSEADDR, and the broker then binds beside it.
    const dial = async (): Promise<Socket> => {
      const socket = connect(at, "127.0.0.1");
      await once(socket, "connect");
      if (states(socket.localPort!).length === 1) return socket;
      socket.destroy();
      return dial();
    };
    const client = await dial();
    const port = client.localPort!;
    const open = run(["up", "--server", `nats://127.0.0.1:${port}`, "--json"], prepared);
    const openLegacy = run(["up", "--server", `nats://127.0.0.1:${port}`], unprepared);
    check("a port an open connection holds with no listener refuses CONFLICT on both routes, saying so and naming no process to stop",
      open.status === 2 && open.envelope?.error?.code === "CONFLICT"
        && (open.envelope.error.message ?? "").includes(`nothing listens at the stack's broker address 127.0.0.1:${port}, but an open connection's local end holds its port (bind failed: address already in use)`)
        && (open.envelope.error.remedy ?? "").includes(`close the connection that holds 127.0.0.1:${port} and retry this start`) && !(open.envelope.error.remedy ?? "").includes("stop the process")
        && openLegacy.status === 2 && openLegacy.stderr.includes(`nothing listens at the broker address 127.0.0.1:${port}, but an open connection's local end holds its port`) && !started(unprepared), { open: shown(open), legacy: shown(openLegacy) });
    client.end();
    await once(client, "close");
    const elsewhere = connect({ port: at, host: "127.0.0.1", localAddress: "127.0.0.2", localPort: port });
    await once(elsewhere, "connect");
    const waiting = states(port);
    check("after the client closed first, its port is in TIME-WAIT with no listener", waiting.length > 0 && waiting.every((state) => state === "06"), waiting);
    check("an open connection from 127.0.0.2 shares the port number", states(port, ["0200007F"]).includes("01"), states(port, ["0200007F"]));
    const timeWait = run(["up", "--server", `nats://127.0.0.1:${port}`, "--json"], prepared);
    const timeWaitLegacy = run(["up", "--server", `nats://127.0.0.1:${port}`], unprepared);
    check("a port in TIME-WAIT with no listener refuses CONFLICT on both routes, saying so, with waiting as the next step",
      timeWait.status === 2 && timeWait.envelope?.error?.code === "CONFLICT"
        && (timeWait.envelope.error.message ?? "").includes(`nothing listens at the stack's broker address 127.0.0.1:${port}, but a closed connection in TIME-WAIT still holds its port (bind failed: address already in use)`)
        && (timeWait.envelope.error.remedy ?? "").includes("wait up to a minute for the TIME-WAIT to clear and retry this start") && !(timeWait.envelope.error.remedy ?? "").includes("stop the process")
        && timeWaitLegacy.status === 2 && timeWaitLegacy.stderr.includes(`nothing listens at the broker address 127.0.0.1:${port}, but a closed connection in TIME-WAIT still holds its port`) && !started(unprepared), { timeWait: shown(timeWait), legacy: shown(timeWaitLegacy) });
    elsewhere.destroy();
    peer.close();
  }

  // The scheme's case and a bare trailing slash are not part of the address: a prepared root records
  // one spelling, so a later up in the other is not refused as another address.
  const spelled = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-spelled-")));
  process.on("exit", () => rmSync(spelled, { recursive: true, force: true }));
  const spelledCreated = run(["space", "create", "upusagespelled", "--root", spelled, "--json"]);
  const upper = run(["up", "--server", `NATS://127.0.0.1:${held}/`, "--json"], spelled);
  let recorded: string | undefined;
  try { recorded = readStackJournal(spelled)?.journal.server; } catch { recorded = undefined; }
  const heldBroker = new RegExp(`another process holds the stack's broker address 127\\.0\\.0\\.1:${held}`);
  check("a prepared root records --server NATS://127.0.0.1:<port>/ as nats://127.0.0.1:<port>, refused only for the held address",
    spelledCreated.status === 0 && upper.status === 2 && heldBroker.test(upper.envelope?.error?.message ?? "") && recorded === `nats://127.0.0.1:${held}`, { recorded, up: shown(upper) });
  const plain = run(["up", "--server", `nats://127.0.0.1:${held}`, "--json"], spelled);
  check("…so --server nats://127.0.0.1:<port> there is the recorded address, not refused as another one",
    plain.status === 2 && plain.envelope?.error?.code === "CONFLICT" && heldBroker.test(plain.envelope.error.message ?? "") && !/recorded at/.test(plain.envelope.error.message ?? ""), shown(plain));
  check("…and neither started a broker", !started(spelled), readdirSync(join(spelled, ".cotal")));

  const now = new Date().toISOString();
  mkdirSync(join(journalRoot, ".cotal"), { mode: 0o700 });
  writeStackJournal(journalRoot, undefined, {
    schemaVersion: 1, kind: "cotal-stack-controller", root: journalRoot, space: "upusagejournal", server: `nats://127.0.0.1:${held}`, mode: "auth",
    members: (["broker", "auth", "delivery", "manager"] as const).map((role) => role === "auth" ? { role, definition: `stack-${role}`, instanceId: null, state: "not-attempted" as const } : { role, definition: `stack-${role}`, instanceId: randomUUID(), state: "stopped" as const }),
    operation: { id: randomUUID(), kind: "down", phase: "completed", recordedAt: now, withAgents: false }, updatedAt: now,
  });
  for (const mode of ["--open", "--user-auth"]) {
    for (const members of [[], ["--no-manager"]]) {
      const mismatch = run(["up", mode, ...members, "--json"], journalRoot);
      const keep = ["cotal up", ...members].join(" ");
      const separate = ["cotal up", mode, ...(mode === "--user-auth" ? ["--idp <auth base URL>"] : []), ...members].join(" ");
      const remedy = mismatch.envelope?.error?.remedy ?? "";
      check(`a pinned-mode refusal with ${[mode, ...members].join(" ")} keeps the requested members in both retries`,
        mismatch.status === 2 && mismatch.envelope?.error?.code === "CONFLICT" && remedy.includes(`\`${keep}\` to keep static auth`)
          && remedy.includes(`then \`${separate}\``) && !started(journalRoot), shown(mismatch));
    }
  }
  writeFileSync(join(journalRoot, "cotal.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: upusagejournal\nbroker:\n  servers: nats://127.0.0.1:${held}\nchannels:\n  general:\n    subscribe: []\n`);
  for (const args of [["up", "-f", "cotal.yaml"], ["up", "-f", "cotal.yaml", "--dry-run"]]) {
    const beside = run(args, journalRoot);
    check(`${args.join(" ")} on a root that holds a controller stack refuses CONFLICT, exit 2, naming inspection and ordinary startup`,
      beside.status === 2 && /CONFLICT/.test(beside.stderr) && /holds the controller stack of space upusagejournal/.test(beside.stderr)
        && beside.stderr.includes("cotal service --space upusagejournal") && beside.stderr.includes(`cotal up --root ${journalRoot} --space upusagejournal`)
        && beside.stderr.includes(`cotal team boot ${join(journalRoot, "cotal.yaml")} --dry-run`)
        && !beside.stderr.includes("cotal team deploy") && !started(journalRoot), shown(beside));
  }

  // A bare up whose folder names a space that runs elsewhere needs a new project folder for a
  // separate space, or the stop for the running one in its own folder. The folder's account names main,
  // as one does after an earlier `up --space main` there. A child process that sends the broker's
  // greeting stands in for the other folder's broker, since `run` blocks this process while up probes it.
  const other = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-other-")));
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-legacy-")));
  process.on("exit", () => { for (const dir of [other, legacy]) rmSync(dir, { recursive: true, force: true }); });
  const { createBrokerAuth, createSpaceAccountAuth } = await import("@cotal-ai/core");
  const { authDir, saveBrokerAuth, saveSpaceAccountAuth } = await import("@cotal-ai/workspace");
  const broker = await createBrokerAuth("upusagelegacy");
  saveBrokerAuth(authDir(legacy), broker);
  saveSpaceAccountAuth(authDir(legacy), await createSpaceAccountAuth(broker, "main"));
  const greeter = spawn(process.execPath, ["-e", `require("node:net").createServer((s) => { s.on("error", () => {}); s.write('INFO {"server_id":"other","proto":1}\\r\\n'); }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`], { stdio: ["ignore", "pipe", "inherit"] });
  const greeting = Number((await once(greeter.stdout!, "data"))[0].toString().trim());
  const { recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  process.env.COTAL_HOME = join(home, ".cotal");
  recordMesh({ space: "main", server: `nats://127.0.0.1:${greeting}`, root: other, mode: "auth", origin: "up", ts: now });
  const requested = `nats://127.0.0.1:${await freePort()}`;
  const inUse = run(["up", "--server", requested], legacy);
  const otherNameHere = run(["up", "--space", "separate", "--server", requested], legacy);
  for (const flags of [["--root", legacy], ["--json"], ["--plain"]]) {
    const r = run(["up", "--space", "separate", "--server", requested, ...flags], legacy);
    const remedy = r.envelope?.error?.remedy ?? r.stderr;
    check(`a second space with ${flags[0]} needs a separate prepared root and keeps the startup options`,
      r.status === 2 && remedy.includes("`cotal space create --root <new-folder> -- separate`") && remedy.includes("--root set to that folder and the other options unchanged"), shown(r));
  }
  // A regression that took the name over started a stack, which is stopped before the cell fails.
  if (started(legacy)) { sandbox(legacy); run(["down", "--yes"], legacy); }
  removeMesh("main");
  delete process.env.COTAL_HOME;
  greeter.kill();
  check("a bare up whose folder names a space running elsewhere offers a new project folder or the stop in the running folder",
    inUse.status === 2 && /Code:\s+CONFLICT/.test(inUse.stderr) && inUse.stderr.includes(`space "main" is already in use by a mesh at nats://127.0.0.1:${greeting} (${other})`)
      && inUse.stderr.includes(`start a separate space in a new project folder outside this one with \`cotal up --space <name>\`, using an unused name and keeping --server if you specified a free address, or stop "main" first with \`cotal down\` in ${other}`), shown(inUse));
  check("changing only the name in the account's folder cannot start that separate space",
    otherNameHere.status === 2 && /Code:\s+CONFLICT/.test(otherNameHere.stderr) && otherNameHere.stderr.includes(`it can't also run "separate"`), shown(otherNameHere));

  // THE SAME SPACE, RUNNING FROM THIS VERY PROJECT, started again at another address. The refusal
  // above belongs to a name another folder holds; here the folder IS that space's project, so the
  // offer to start a separate space in it names the project it is already in. A subfolder of the
  // project resolves to the same root, which is where `up` there reaches this branch at all.
  const inner = join(legacy, "inner");
  mkdirSync(inner, { recursive: true });
  const greeterHere = spawn(process.execPath, ["-e", `require("node:net").createServer((s) => { s.on("error", () => {}); s.write('INFO {"server_id":"here","proto":1}\\r\\n'); }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`], { stdio: ["ignore", "pipe", "inherit"] });
  const here = Number((await once(greeterHere.stdout!, "data"))[0].toString().trim());
  process.env.COTAL_HOME = join(home, ".cotal");
  recordMesh({ space: "main", server: `nats://127.0.0.1:${here}`, root: legacy, mode: "auth", origin: "up", ts: now });
  const elsewhereAddress = `nats://127.0.0.1:${await freePort()}`;
  const ownProject = run(["up", "--server", elsewhereAddress], legacy);
  const subfolder = run(["up", "--server", elsewhereAddress], inner);
  if (started(legacy)) { sandbox(legacy); run(["down", "--yes"], legacy); }
  removeMesh("main");
  delete process.env.COTAL_HOME;
  greeterHere.kill();
  for (const [where, r] of [["its own project root", ownProject], ["a subfolder of that project", subfolder]] as const)
    check(`up --server naming another address, run from ${where} of a space that runs there, refuses CONFLICT, exit 2, naming the address it runs at and the bare up that reaches it`,
      r.status === 2 && /Code:\s+CONFLICT/.test(r.stderr)
        && r.stderr.includes(`space "main" already runs from this project at nats://127.0.0.1:${here}, and this start names ${elsewhereAddress}`)
        && r.stderr.includes(`run \`cotal up\` here with no --server or --host to reach the mesh at nats://127.0.0.1:${here}, or stop it first with \`cotal down\` in ${legacy}`)
        && !r.stderr.includes("start a separate space in this folder"), shown(r));
} finally {
  holder.close();
}

finish();
process.exit(process.exitCode ?? 0);
