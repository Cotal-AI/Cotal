import { spawn, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";
import {
  delegatedSeatCommand,
  managedRuntimeKey,
  parseManagedLifecycleHandoff,
  registry,
  SpawnRefused,
  type AgentHandle,
  type DelegatedSeatLaunch,
  type LaunchSpec,
  type ManagedLifecycleHandoff,
  type Runtime,
  type RuntimeProvider,
} from "@cotal-ai/core";

/** Trusted operator inputs. The root filesystem contains the installed CLI and harness, but no
 * operator login, signer, registry or host socket. Its /usr/bin/cotal must support managed handoff. */
export interface BubblewrapOptions {
  rootfs: string;
  /** Absolute host executable, never resolved from a seat's launch environment. */
  executable?: string;
}

/** A delegated Linux seat. No LaunchSpec or path from the manager's filesystem crosses this
 * boundary. The only per-seat inputs are its scoped handoff and persona, copied through pipes. */
export class BubblewrapRuntime implements Runtime {
  readonly kind = "bubblewrap";
  readonly streamsTerminal = false;
  private readonly rootfs: string;
  private readonly executable: string;
  private readonly launches = new Set<string>();

  constructor(options: BubblewrapOptions) {
    if (process.platform !== "linux") throw new Error("bubblewrap runtime requires Linux");
    if (!isAbsolute(options.rootfs)) throw new Error("bubblewrap runtime requires an absolute rootfs path");
    this.rootfs = realpathSync(options.rootfs);
    if (this.rootfs === "/" || !statSync(this.rootfs).isDirectory())
      throw new Error("bubblewrap runtime requires a dedicated root filesystem, not the host root");
    if ((statSync(this.rootfs).mode & 0o022) !== 0)
      throw new Error("bubblewrap runtime root filesystem must not be group- or world-writable");
    this.executable = options.executable ?? "/usr/bin/bwrap";
    if (!isAbsolute(this.executable)) throw new Error("bubblewrap runtime requires an absolute executable path");
    const probe = spawnSync(this.executable, ["--version"], { encoding: "utf8", timeout: 2_000, env: {} });
    if (probe.status !== 0) throw new Error("bubblewrap runtime executable is unavailable");
  }

  spawn(_name: string, _spec: LaunchSpec, _cwd: string): AgentHandle {
    throw new SpawnRefused("bubblewrap runtime requires delegated user-auth enrollment; manager-local launch paths are not supported");
  }

  spawnDelegated(launch: DelegatedSeatLaunch, handoff: ManagedLifecycleHandoff): AgentHandle {
    // Validate before giving the native runtime anything. Diagnostics name fields, never secrets.
    const text = JSON.stringify(handoff);
    parseManagedLifecycleHandoff(text, handoff);
    const key = managedRuntimeKey(handoff);
    if (this.launches.has(key)) throw new SpawnRefused("bubblewrap runtime already launched this lifecycle");
    const command = delegatedSeatCommand(launch, handoff, { handoff: "/run/cotal/handoff.json", persona: "/run/cotal/persona.md" });
    const args = [
      "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--disable-userns", "--new-session", "--die-with-parent", "--cap-drop", "ALL",
      "--ro-bind", this.rootfs, "/", "--proc", "/proc", "--dev", "/dev",
      "--perms", "0700", "--tmpfs", "/home", "--dir", "/home/seat",
      "--perms", "0700", "--tmpfs", "/run", "--dir", "/run/cotal",
      "--perms", "0700", "--tmpfs", "/tmp", "--perms", "0700", "--tmpfs", "/scratch", "--perms", "0700", "--tmpfs", "/workspace",
      "--perms", "0600", "--file", "3", "/run/cotal/handoff.json",
      "--perms", "0600", "--file", "4", "/run/cotal/persona.md",
      "--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
      "--setenv", "HOME", "/home/seat", "--setenv", "COTAL_HOME", "/home/seat/.cotal",
      "--setenv", "XDG_CONFIG_HOME", "/home/seat/.config", "--setenv", "XDG_DATA_HOME", "/home/seat/.local/share",
      "--setenv", "XDG_STATE_HOME", "/home/seat/.local/state", "--setenv", "XDG_CACHE_HOME", "/home/seat/.cache",
      "--setenv", "XDG_RUNTIME_DIR", "/run/cotal", "--setenv", "TMPDIR", "/scratch",
    ];
    for (const [name, value] of Object.entries(command.env)) args.push("--setenv", name, value);
    args.push("--chdir", "/workspace", "--", "/usr/bin/cotal", ...command.args);
    // Record before handing off. An uncertain spawn is never retried for the same lifecycle.
    this.launches.add(key);
    const child = spawn(this.executable, args, { env: {}, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    let alive = true;
    let exit: { code?: number; signal?: number; diagnostic?: string } | undefined;
    const drain = (): void => {};
    child.stdout!.on("data", drain);
    child.stderr!.on("data", drain);
    const handed = [text, launch.persona];
    for (let i = 0; i < handed.length; i++) {
      const pipe = child.stdio[i + 3] as import("node:stream").Writable;
      // EPIPE means native setup refused before reading the input. The child's exit is the result.
      pipe.on("error", () => {});
      pipe.end(handed[i]);
    }
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let settle!: () => void;
    const ended = new Promise<void>((resolve) => { settle = resolve; });
    let failedToStart = false;
    child.on("error", () => { failedToStart = true; });
    child.on("close", (code, signal) => {
      alive = false;
      clearTimeout(stopTimer);
      // Do not surface child output: a compromised seat may put its handoff in a diagnostic.
      exit = {
        ...(code === null ? {} : { code }),
        ...(signal ? { signal: osConstants.signals[signal] } : {}),
        ...(failedToStart ? { diagnostic: "bubblewrap runtime failed to start its native executable" } : {}),
      };
      settle();
    });
    return {
      name: handoff.actor,
      kind: this.kind,
      get pid() { return child.pid; },
      status: () => alive ? "running" : "exited",
      exitInfo: () => exit,
      stop: (options) => {
        if (!alive) return;
        child.kill(options?.graceful === false ? "SIGKILL" : "SIGTERM");
        if (options?.graceful !== false && !stopTimer)
          stopTimer = setTimeout(() => { if (alive) child.kill("SIGKILL"); }, 2_000);
      },
      waitForExit: () => ended,
      interrupt: () => { if (alive) child.kill("SIGINT"); },
      attach: () => { throw new Error("bubblewrap runtime has no terminal attach; observe the seat through the mesh"); },
    };
  }
}

/** Explicitly selected by the operator. An absent rootfs fails rather than launching same-user. */
export const bubblewrapRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "bubblewrap",
  available: () => process.platform === "linux",
  create: () => {
    const rootfs = process.env.COTAL_BUBBLEWRAP_ROOTFS;
    if (!rootfs) throw new Error("bubblewrap runtime requires COTAL_BUBBLEWRAP_ROOTFS with a credential-free seat image");
    return new BubblewrapRuntime({ rootfs });
  },
};
registry.register(bubblewrapRuntimeProvider);
