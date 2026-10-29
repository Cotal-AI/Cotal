import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PaseoClient } from "@getpaseo/client";
import {
  hardenPrivate,
  launcherSource,
  registry,
  SpawnRefused,
  confirmWatch,
  writeSecretFile,
  type AgentHandle,
  type ConfirmPane,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
} from "@cotal-ai/core";
import * as paseo from "./driver.js";

const GRACE_MS = 2_000;
/** How old a terminal census may be before a status read starts a fresh one. */
const CENSUS_MS = 1_000;
const EXIT_WAIT_MS = 15_000;
/** The size a terminal starts at; the Paseo app resizes it when someone opens it. */
const TERMINAL_SIZE = { rows: 40, cols: 120 };

export interface PrivateLauncher {
  dir: string;
  script: string;
}

/** The seat's launch env and credentials, in an owner-only script that deletes its own directory as
 *  it loads. The Paseo terminal runs this script directly, so nothing secret reaches the terminal. */
export function privateLauncher(spec: LaunchSpec, cwd: string): PrivateLauncher {
  const dir = mkdtempSync(join(tmpdir(), "cotal-paseo-"));
  hardenPrivate(dir, "dir");
  const script = join(dir, "launch.mjs");
  writeSecretFile(script, launcherSource("[cotal-paseo-launch]", { cwd, command: spec.command, args: spec.args, env: spec.env ?? {} }));
  return { dir, script };
}

function cleanupLauncher(launcher: PrivateLauncher): void {
  try {
    rmSync(launcher.dir, { recursive: true, force: true });
  } catch {
    /* the launcher also removes itself after loading */
  }
}

/** The daemon's terminal ids. Paseo drops a terminal once its process exits, so a listing that
 *  lacks a terminal is the exit evidence. Refreshes run off the event loop, so `status()` never
 *  waits on the daemon. */
export class TerminalCensus {
  #ids: Set<string> | undefined;
  #taken = 0;
  #generation = 0;
  #inflight: Promise<void> | undefined;
  #lastStart = 0;

  constructor(private readonly list: () => Promise<string[]>) {}

  /** The generation the next listing will carry. A seat records it once its terminal exists; only a
   *  later listing can say the terminal is gone. */
  get generation(): number {
    return this.#generation + 1;
  }

  /** Resolves with a listing that started after this call or with an in-flight one; rejects when
   *  the daemon cannot be listed. */
  refresh(): Promise<void> {
    this.#inflight ??= (async () => {
      const generation = ++this.#generation;
      try {
        this.#ids = new Set(await this.list());
        this.#taken = generation;
      } finally {
        this.#inflight = undefined;
      }
    })();
    return this.#inflight;
  }

  /** False only when a listing taken at or after generation `since` lacks `id`. Anything else,
   *  including a daemon that cannot be listed, is not evidence that the terminal is gone. */
  present(id: string, since: number, maxAgeMs = CENSUS_MS): boolean {
    if (!this.#inflight && this.#lastStart + maxAgeMs <= Date.now()) {
      this.#lastStart = Date.now();
      this.refresh().catch(() => {});
    }
    return !(this.#ids && this.#taken >= since && !this.#ids.has(id));
  }

  /** Resolve once a listing taken at or after generation `since` lacks `id`. Rejects on timeout or
   *  when the daemon cannot be listed. */
  async gone(id: string, since: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      await this.refresh();
      if (!(this.#ids && this.#taken >= since && this.#ids.has(id))) return;
      if (Date.now() >= deadline) throw new Error(`paseo: terminal ${id} did not exit within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Spawns each managed agent into a Paseo workspace terminal for the launch cwd, over one SDK
 *  connection to the local daemon. */
export class PaseoRuntime implements Runtime {
  readonly kind = "paseo" as const;
  readonly streamsTerminal = false;
  #client: Promise<PaseoClient> | undefined;
  #connected: PaseoClient | undefined;
  readonly #census = new TerminalCensus(async () => (await (await this.#connect()).terminals.list()).entries.map((t) => t.id));

  #connect(): Promise<PaseoClient> {
    this.#client ??= paseo.connect().then(
      (client) => (this.#connected = client),
      (err: unknown) => {
        this.#client = undefined;
        throw err;
      },
    );
    return this.#client;
  }

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new SpawnRefused(`paseo runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`);
    if (this.#connected?.getConnectionState().status !== "connected" && !paseo.available())
      throw new SpawnRefused("paseo runtime: the Paseo daemon is not reachable (run `paseo daemon status`)");

    // No terminal exists yet, so a failure here (a confirm prompt that cannot match, a launcher
    // script that cannot be written) is a refusal.
    let watch: ((pane: ConfirmPane) => void) | undefined;
    let launcher: PrivateLauncher;
    try {
      if ((spec.confirmBefore?.length || spec.confirmReady?.length || spec.confirmBlockers?.length) && spec.confirm === undefined) throw new Error("startup choices require a final confirmation prompt");
      watch = spec.confirm === undefined ? undefined : confirmWatch(spec.confirm, spec.confirmBefore, spec.confirmReady, spec.confirmBlockers);
      launcher = privateLauncher(spec, cwd);
    } catch (err) {
      throw new SpawnRefused((err as Error).message);
    }

    const title = `cotal-${name}`;
    let id: string | undefined;
    let since = 0;
    /** Why this runtime ended the seat itself: the terminal could not be created, or the startup
     *  confirmation failed. */
    let reason: string | undefined;
    let createFailed = false;
    let stopWhenCreated = false;

    const kill = (): void => {
      if (id === undefined) {
        stopWhenCreated = true;
        return;
      }
      const terminalId = id;
      void (async () => {
        try {
          await this.#census.refresh();
          if (this.#census.present(terminalId, since)) await (await this.#connect()).terminals.ref(terminalId).kill();
        } catch (err) {
          console.error(`paseo runtime: failed to kill terminal ${terminalId} for "${name}":`, err);
        } finally {
          cleanupLauncher(launcher);
        }
      })();
    };
    const send = (keys: string[]): void => {
      if (id === undefined || !this.#connected) throw new Error(`paseo runtime: "${name}" has no terminal yet`);
      this.#connected.terminals.ref(id).sendKeys(keys);
    };

    const created = (async () => {
      try {
        const client = await this.#connect();
        const workspace = await client.workspaces.open(cwd);
        const terminal = await client.terminals.create({
          workspaceId: workspace.id,
          cwd,
          name: title,
          command: process.execPath,
          args: [launcher.script],
          size: TERMINAL_SIZE,
        });
        since = this.#census.generation;
        id = terminal.id;
        if (stopWhenCreated) kill();
      } catch (err) {
        createFailed = true;
        reason = `paseo runtime: could not create a terminal for "${name}": ${(err as Error).message}`;
        console.error(reason);
        cleanupLauncher(launcher);
      }
    })();

    const status = (): "running" | "exited" => {
      if (createFailed) return "exited";
      if (id === undefined) return "running";
      return this.#census.present(id, since) ? "running" : "exited";
    };

    let screen = "";
    let capturing = false;
    watch?.({
      read: () => {
        if (status() === "exited") return undefined;
        if (id === undefined || !this.#connected) return "";
        if (!capturing) {
          capturing = true;
          this.#connected.terminals
            .ref(id)
            .capture({ stripAnsi: true })
            .then((captured) => void (screen = captured.lines.join("\n")))
            .catch(() => {})
            .finally(() => void (capturing = false));
        }
        return screen;
      },
      enter: () => send(["Enter"]),
      down: () => send(["\x1b[B"]),
      fail: (message) => {
        reason = message;
        console.error(`paseo runtime: "${name}": ${message}`);
        kill();
      },
    });

    return {
      name,
      kind: "paseo",
      status,
      stop: (opts) => {
        if (opts?.graceful === false) {
          kill();
          return;
        }
        try {
          send(["/exit", "Enter"]);
        } catch {
          /* still ensure it closes below */
        }
        setTimeout(kill, GRACE_MS);
      },
      waitForExit: async () => {
        await created;
        if (id === undefined) return;
        await this.#census.gone(id, since, EXIT_WAIT_MS);
        cleanupLauncher(launcher);
      },
      interrupt: () => send(["C-c"]),
      exitInfo: () => (status() === "exited" && reason !== undefined ? { diagnostic: reason } : undefined),
      attach: () => {
        throw new Error(
          `paseo runtime: watch this agent in the Paseo app, terminal "${title}" in the workspace for ${cwd}` +
            (id ? `; run \`paseo terminal capture ${id}\` to read its screen` : ""),
        );
      },
    };
  }
}

/** Self-registering runtime provider: `import "@cotal-ai/paseo"` makes the manager's `paseo`
 *  runtime available without the manager depending on this package. */
export const paseoRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "paseo",
  available: () => paseo.available(),
  create: () => new PaseoRuntime(),
};

registry.register(paseoRuntimeProvider);
