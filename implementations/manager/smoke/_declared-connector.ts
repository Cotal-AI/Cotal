import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Publish one fixture connector using the same metadata shape as an installed plugin. */
export function writeDeclaredConnector(root: string, pkg: string, name: string, module: string, eventPlane = false): void {
  const dir = join(root, "node_modules", pkg);
  mkdirSync(dir, { recursive: true });
  const provides = [{ kind: "connector", name, aliases: [] }];
  const connectors = [{ name, requires: [], eventPlane, prompts: false, askPermissions: false, reasoningEvents: false, setup: null }];
  const metadata = { provides, commands: [], connectors, localProcesses: [], servicePresets: [] };
  const version = "1.0.0";
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version, type: "module", main: "index.js", cotal: { contract: 1, ...metadata } }));
  writeFileSync(join(dir, "index.js"), module);
  writeFileSync(join(root, "extensions.json"), JSON.stringify({ extensions: [{ pkg, version, installId: randomUUID(), spec: `file:${pkg}`, ...metadata }] }));
}
