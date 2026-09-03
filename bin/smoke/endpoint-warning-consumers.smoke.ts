import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Proof = "behavioral" | "structural";
type Site = {
  cell: string;
  consumer: string;
  disposition: "surface" | "ignore";
  source: string;
  dist: string;
  sourceNeedle: string;
  distNeedle: string;
  proof: Proof;
  limit: string;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compact = (text: string): string => text.replace(/\s+/g, "");
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
const BUNDLED_MESH_AGENT_ARTIFACTS = [
  "extensions/connector-claude-code/dist/mcp.cjs",
  "extensions/connector-codex/dist/host.js",
  "extensions/connector-hermes/dist/launch.js",
  "extensions/connector-hermes/plugin/cotal/_sidecar/standalone.cjs",
  "extensions/connector-jcode/dist/host.js",
  "extensions/connector-opencode/dist/plugin.bundle.js",
  "extensions/pi/dist/index.js",
  "extensions/pi/dist/standalone.js",
] as const;

/**
 * Each row names the shipped consumer's own registration in source and in the published artifact.
 * The smoke command rebuilds every affected package first, so a source mutation must disappear from
 * both sides. `behavioral` means a companion committed cell also drives the consumer-owned handler.
 * `structural` proves the registration is present in the shipped artifact, not that an inline handler
 * remains non-empty. That limit is stated per row rather than hidden behind one aggregate count.
 */
const sites: Site[] = [
  {
    cell: "MeshAgent surfaces endpoint warnings without changing readiness",
    consumer: "connector MeshAgent",
    disposition: "surface",
    source: "extensions/connector-core/src/agent.ts",
    dist: "extensions/connector-core/dist/agent.js",
    sourceNeedle: 'this.ep.on("warning", (e: Error) => this.handleEndpointWarning(e));',
    distNeedle: 'this.ep.on("warning",(e)=>this.handleEndpointWarning(e));',
    proof: "behavioral",
    limit: "orientation.smoke drives this registration and checks both the operator log and connectionIssue",
  },
  {
    cell: "manager surfaces endpoint warnings through its supervisor diagnostic",
    consumer: "manager supervisor",
    disposition: "surface",
    source: "implementations/manager/src/manager.ts",
    dist: "implementations/manager/dist/manager.js",
    sourceNeedle: 'this.ep.on("warning", reportEndpoint);',
    distNeedle: 'this.ep.on("warning",reportEndpoint);',
    proof: "structural",
    limit: "the shipped registration is proven; the console.error handler body is not executed by this suite",
  },
  {
    cell: "web surfaces endpoint warnings through its operator stderr",
    consumer: "web dashboard",
    disposition: "surface",
    source: "implementations/web/src/web.ts",
    dist: "implementations/web/dist/web.js",
    sourceNeedle: 'ep.on("warning", (e: Error) => console.error(c.yellow("! " + e.message)));',
    distNeedle: 'ep.on("warning",(e)=>console.error(c.yellow("! "+e.message)));',
    proof: "structural",
    limit: "the shipped registration is proven; the colored stderr handler is not executed by this suite",
  },
  {
    cell: "feedback intake surfaces endpoint warnings through daemon stderr",
    consumer: "feedback intake daemon",
    disposition: "surface",
    source: "implementations/delivery/src/feedback-intake.ts",
    dist: "implementations/delivery/dist/feedback-intake.js",
    sourceNeedle: 'ep.on("warning", (e: Error) => console.error(c.red("! " + e.message)));',
    distNeedle: 'ep.on("warning",(e)=>console.error(c.red("! "+e.message)));',
    proof: "structural",
    limit: "the shipped registration is proven; the stderr handler is not executed by this suite",
  },
  {
    cell: "transient CLI commands surface endpoint warnings",
    consumer: "CLI transient endpoint",
    disposition: "surface",
    source: "implementations/cli/src/lib/transient.ts",
    dist: "implementations/cli/dist/lib/transient.js",
    sourceNeedle: 'ep.on("warning", (e: Error) => console.error(c.yellow("! " + e.message)));',
    distNeedle: 'ep.on("warning",(e)=>console.error(c.yellow("! "+e.message)));',
    proof: "structural",
    limit: "the shipped registration is proven; individual send/endpoints/personas commands are not spawned",
  },
  {
    cell: "spawn manifest probe surfaces recoverable warnings without blocking deploy",
    consumer: "CLI spawn manifest probe",
    disposition: "surface",
    source: "implementations/cli/src/lib/manifest/live.ts",
    dist: "implementations/cli/dist/lib/manifest/live.js",
    sourceNeedle: 'ep.on("warning", (e: Error) => console.error(`! spawn-f probe: ${e.message}`));',
    distNeedle: 'ep.on("warning",(e)=>console.error(`!spawn-fprobe:${e.message}`));',
    proof: "structural",
    limit: "the shipped registration is proven; a long user-mode deploy is not launched by this suite",
  },
  {
    cell: "join provisioner deliberately ignores recoverable side-channel warnings",
    consumer: "CLI join provisioner",
    disposition: "ignore",
    source: "implementations/cli/src/commands/join.ts",
    dist: "implementations/cli/dist/commands/join.js",
    sourceNeedle: 'prov.on("warning", ignoreProvisionerWarning);',
    distNeedle: 'prov.on("warning",ignoreProvisionerWarning);',
    proof: "structural",
    limit: "the explicit ignore is proven; the awaited provisioning failure path owns behavioral coverage",
  },
  {
    cell: "join session surfaces recoverable warnings through prompt-safe output",
    consumer: "CLI join session",
    disposition: "surface",
    source: "implementations/cli/src/commands/join.ts",
    dist: "implementations/cli/dist/commands/join.js",
    sourceNeedle: 'ep.on("warning", (e: Error) => print(c.yellow(`! ${e.message}`)));',
    distNeedle: 'ep.on("warning",(e)=>print(c.yellow(`!${e.message}`)));',
    proof: "structural",
    limit: "the shipped registration is proven; an interactive readline session is not started",
  },
  {
    cell: "status snapshot deliberately ignores recoverable side-channel warnings",
    consumer: "CLI status snapshot",
    disposition: "ignore",
    source: "implementations/cli/src/commands/status.ts",
    dist: "implementations/cli/dist/commands/status.js",
    sourceNeedle: 'ep.on("warning", ignoreSnapshotWarning);',
    distNeedle: 'ep.on("warning",ignoreSnapshotWarning);',
    proof: "structural",
    limit: "the explicit ignore is proven; awaited rows and their unavailable results own behavioral coverage",
  },
  {
    cell: "status component probe deliberately ignores recoverable side-channel warnings",
    consumer: "CLI status component probe",
    disposition: "ignore",
    source: "implementations/cli/src/commands/status.ts",
    dist: "implementations/cli/dist/commands/status.js",
    sourceNeedle: 'ep.on("warning", ignoreComponentWarning);',
    distNeedle: 'ep.on("warning",ignoreComponentWarning);',
    proof: "structural",
    limit: "the explicit ignore is proven; the awaited manager reply owns behavioral coverage",
  },
  {
    cell: "spawn naming probe deliberately ignores recoverable advisory warnings",
    consumer: "CLI spawn naming probe",
    disposition: "ignore",
    source: "implementations/cli/src/commands/spawn.ts",
    dist: "implementations/cli/dist/commands/spawn.js",
    sourceNeedle: 'ep.on("warning", ignoreNameProbeWarning);',
    distNeedle: 'ep.on("warning",ignoreNameProbeWarning);',
    proof: "structural",
    limit: "the explicit ignore is proven; the advisory roster settle is not run",
  },
  {
    cell: "static spawn provisioner surfaces recoverable warnings",
    consumer: "CLI static spawn provisioner",
    disposition: "surface",
    source: "implementations/cli/src/commands/spawn.ts",
    dist: "implementations/cli/dist/commands/spawn.js",
    sourceNeedle: 'prov.on("warning", reportStaticProvisioner);',
    distNeedle: 'prov.on("warning",reportStaticProvisioner);',
    proof: "structural",
    limit: "the shipped registration is proven; static provisioning is not executed",
  },
  {
    cell: "user spawn provisioner surfaces recoverable warnings",
    consumer: "CLI user spawn provisioner",
    disposition: "surface",
    source: "implementations/cli/src/commands/spawn.ts",
    dist: "implementations/cli/dist/commands/spawn.js",
    sourceNeedle: 'prov.on("warning", reportUserProvisioner);',
    distNeedle: 'prov.on("warning",reportUserProvisioner);',
    proof: "structural",
    limit: "the shipped registration is proven; user provisioning is not executed",
  },
  {
    cell: "MeshView consumes endpoint warnings into its shared operator model",
    consumer: "CLI MeshView",
    disposition: "surface",
    source: "implementations/cli/src/view/mesh-view.ts",
    dist: "implementations/cli/dist/view/mesh-view.js",
    sourceNeedle: 'this.ep.on("warning", this.onWarning);',
    distNeedle: 'this.ep.on("warning",this.onWarning);',
    proof: "behavioral",
    limit: "view.smoke drives this registration and checks both the snapshot and stream event",
  },
  {
    cell: "plain console renders MeshView warnings",
    consumer: "CLI plain console renderer",
    disposition: "surface",
    source: "implementations/cli/src/render.ts",
    dist: "implementations/cli/dist/render.js",
    sourceNeedle: 'view.on("warning", (e: Error) => console.error(c.yellow("! " + e.message)));',
    distNeedle: 'view.on("warning",(e)=>console.error(c.yellow("! "+e.message)));',
    proof: "structural",
    limit: "the shipped registration is proven; console stderr is not captured by this suite",
  },
  {
    cell: "delivery daemon remains subscribed to recoverable endpoint warnings",
    consumer: "delivery daemon",
    disposition: "surface",
    source: "implementations/delivery/src/delivery.ts",
    dist: "implementations/delivery/dist/delivery.js",
    sourceNeedle: 'ep.on("warning", say);',
    distNeedle: 'ep.on("warning",say);',
    proof: "structural",
    limit: "delivery-renewal owns the daemon behavior; this census keeps the shipped registration in the full closure",
  },
];

let failures = 0;
for (const site of sites) {
  const source = compact(readFileSync(join(root, site.source), "utf8"));
  const dist = compact(readFileSync(join(root, site.dist), "utf8"));
  const sourceCount = occurrences(source, compact(site.sourceNeedle));
  const distCount = occurrences(dist, compact(site.distNeedle));
  const ok = sourceCount === 1 && distCount === 1;
  console.log(`${ok ? "✓" : "✗"} ${site.cell}${ok ? "" : ` (source=${sourceCount}, dist=${distCount})`}`);
  if (site.proof === "structural") console.log(`    residual: ${site.limit}`);
  if (!ok) failures++;
}

const sourceFiles = new Set(sites.map((site) => site.source));
const distFiles = new Set(sites.map((site) => site.dist));
const sourcePopulation = [...sourceFiles].reduce(
  (count, path) => count + occurrences(readFileSync(join(root, path), "utf8"), '.on("warning"'),
  0,
);
const distPopulation = [...distFiles].reduce(
  (count, path) => count + occurrences(readFileSync(join(root, path), "utf8"), '.on("warning"'),
  0,
);
assert.equal(sourcePopulation, sites.length, "the source census has no unnamed warning registrations");
assert.equal(distPopulation, sites.length, "the published-artifact census has no unnamed warning registrations");
assert.ok(sites.some((site) => site.disposition === "ignore"), "the census cannot silently erase all deliberate ignores");
assert.ok(sites.some((site) => site.proof === "behavioral"), "the census names its behavioral companions");

for (const path of BUNDLED_MESH_AGENT_ARTIFACTS) {
  const body = compact(readFileSync(join(root, path), "utf8"));
  assert.equal(
    occurrences(body, 'this.ep.on("warning",(e)=>this.handleEndpointWarning(e));'),
    1,
    `${path} carries the MeshAgent warning registration in the actual customer-loaded bundle`,
  );
}

const builtRoots = [join(root, "extensions"), join(root, "implementations")];
const discovered = new Set<string>();
const walkBuilt = (path: string): void => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "plugin" || path.includes("/dist") || path.includes("/plugin")) walkBuilt(child);
      else if (path === join(root, "extensions") || path === join(root, "implementations")) walkBuilt(child);
      continue;
    }
    if (!/\.(?:js|cjs)$/.test(entry.name) || statSync(child).size > 8_000_000) continue;
    if (readFileSync(child, "utf8").includes('.on("warning"')) discovered.add(child.slice(root.length + 1));
  }
};
for (const path of builtRoots) walkBuilt(path);
const expectedBuiltFiles = new Set([...distFiles, ...BUNDLED_MESH_AGENT_ARTIFACTS]);
assert.deepEqual(
  [...discovered].sort(),
  [...expectedBuiltFiles].sort(),
  "the artifact census discovers every built warning-listener file independently of the site manifest",
);

console.log(`endpoint-warning-consumers: ${sites.length} named registrations across ${sourceFiles.size} source files and ${expectedBuiltFiles.size} published artifacts`);
if (failures) process.exitCode = 1;
