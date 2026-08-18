import { basename, dirname } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  MeshAgent,
  configFromEnv,
  hasIdentity,
  startControlServer,
  type AgentConfig,
  type InboxItem,
  controlFromEnv,
  scrubLaunchMaterial,
} from "@cotal-ai/connector-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiDriver, type CotalBatchDetails, type PiContextLike } from "./driver.js";
import { registerCotalTools } from "./tools.js";

const CUSTOM_TYPE = "cotal-inbox";
const RUNTIMES = Symbol.for("cotal.pi.runtimes");

interface PiRuntime {
  config: AgentConfig;
  mesh: MeshAgent;
  driver: PiDriver;
  controlServer?: ReturnType<typeof startControlServer>;
  personaCleaned: boolean;
}

type GlobalWithPi = typeof globalThis & { [RUNTIMES]?: Map<string, PiRuntime> };

function runtimeMap(): Map<string, PiRuntime> {
  const root = globalThis as GlobalWithPi;
  return (root[RUNTIMES] ??= new Map());
}

function runtimeKey(config: AgentConfig): string {
  return `${config.space}\0${config.id ?? config.name}`;
}

function asContext(context: ExtensionContext): PiContextLike {
  return context;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function wrapped(line: string): { render(width: number): string[]; invalidate(): void } {
  return {
    invalidate(): void {},
    render(width: number): string[] {
      const size = Math.max(16, width);
      const out: string[] = [];
      for (const source of line.split("\n")) {
        let rest = source;
        while (rest.length > size) {
          const whitespace = rest.lastIndexOf(" ", size);
          const cut = whitespace > size / 2 ? whitespace : size;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut).trimStart();
        }
        out.push(rest);
      }
      return out;
    },
  };
}

function cleanPersonaFile(runtime: PiRuntime): void {
  if (runtime.personaCleaned) return;
  runtime.personaCleaned = true;
  const file = process.env.COTAL_PI_PERSONA_FILE;
  if (!file) return;
  const dir = dirname(file);
  if (basename(file) !== "persona.md" || !basename(dir).startsWith("cotal-persona-") || dirname(dir) !== tmpdir())
    return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A pre-start crash can leave the OS-temp file behind; normal cleanup remains best-effort.
  }
}

function createRuntime(config: AgentConfig): PiRuntime {
  // The socket path rides the env; the first-frame token rides the launch material, so a shell this
  // seat runs cannot pick a control-plane bearer out of its own environment.
  const control = controlFromEnv();
  if (process.env.COTAL_CONTROL_SOCKET?.trim() && !control) {
    throw new Error("pi connector: COTAL_CONTROL_SOCKET was set without a matching control token in the launch material");
  }

  const mesh = new MeshAgent(config);
  const driver = new PiDriver(mesh);
  const runtime: PiRuntime = {
    config,
    mesh,
    driver,
    personaCleaned: false,
  };

  mesh.on("incoming", () => driver.onIncoming());
  mesh.on("wake", () => driver.onWake());
  mesh.on("mention-wake", (item: InboxItem) => driver.onMentionWake(item));
  mesh.start();

  if (control) {
    runtime.controlServer = startControlServer(
      mesh,
      control,
      async () => ({ ok: false, error: "pi uses in-process lifecycle events; only shutdown is supported" }),
      { fatalBind: true, onShutdown: () => driver.requestShutdown() },
    );
  }
  return runtime;
}

/** Load Cotal into the operator's Pi. With no mesh identity this extension is completely inert. */
export default async function cotalMesh(pi: ExtensionAPI): Promise<void> {
  if (!hasIdentity()) return;
  if (typeof pi.sendMessage !== "function" || typeof pi.registerMessageRenderer !== "function" || typeof pi.on !== "function") {
    throw new Error("pi connector: this Pi version lacks the required custom-message lifecycle API (requires Pi 0.79.10)");
  }

  const config = configFromEnv();
  // Everything this session needs is now in `config` and in the control pair below, so the pointer
  // to the launch material has no reader left. Dropping it here is what keeps it out of the
  // environment of every shell command, build and tool this seat goes on to run.
  scrubLaunchMaterial();
  config.connector = "pi";
  const key = runtimeKey(config);
  const runtimes = runtimeMap();
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRuntime(config);
    runtimes.set(key, runtime);
  }
  runtime.driver.bind(pi);
  registerCotalTools(pi, runtime.mesh, runtime.config);
  pi.registerMessageRenderer<CotalBatchDetails>(CUSTOM_TYPE, (message) => wrapped(messageText(message.content)));

  pi.on("session_start", (_event, context) => {
    cleanPersonaFile(runtime);
    runtime.driver.onSessionStart(asContext(context));
  });
  pi.on("agent_start", (_event, context) => runtime.driver.onAgentStart(asContext(context)));
  pi.on("message_start", (event) => runtime.driver.onMessageStart(event.message));
  pi.on("context", (event) => runtime.driver.onContext(event.messages));
  pi.on("after_provider_response", (event) => runtime.driver.onProviderResponse(event.status));
  pi.on("tool_execution_start", (event) => runtime.driver.onToolStart(event.toolName));
  pi.on("tool_execution_end", () => runtime.driver.onToolEnd());
  pi.on("session_before_compact", (event) => runtime.driver.onBeforeCompact(event.reason, event.willRetry));
  pi.on("agent_end", (event, context) => runtime.driver.onAgentEnd(event.messages, asContext(context)));
  pi.on("session_shutdown", async (event) => {
    runtime.driver.onSessionShutdown();
    if (event.reason !== "quit") return;
    await runtime.driver.quit();
    try {
      runtime.controlServer?.close();
    } catch {
      // The server may already be closing after the manager's shutdown request.
    }
    await runtime.mesh.stop().catch(() => {});
    runtimes.delete(key);
  });
}
