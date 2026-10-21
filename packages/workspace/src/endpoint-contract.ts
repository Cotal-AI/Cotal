import {
  compileContract, endpointToken, isReverseDnsUrn, parseClusterDocument, VOID_SCHEMA_DIGEST,
  buildContractClosureManifest, contractDigest, type ClusterCommand, type ClusterDocument,
  type CompiledContract, type SchemaBundle,
} from "@cotal-ai/core";
import { CommandFailure } from "./output.js";

export const MAX_ENDPOINT_CONTRACT_BYTES = 1024 * 1024;
export interface EndpointCommandSource extends Omit<ClusterCommand, "inputDigest" | "outputDigest"> {
  readonly input: SchemaBundle;
  readonly output: SchemaBundle;
}
export interface EndpointContractSource {
  readonly schemaVersion: 1;
  readonly endpoint: string;
  readonly cluster: {
    readonly urn: string;
    readonly revision: number;
    readonly attributes: readonly unknown[];
    readonly commands: readonly EndpointCommandSource[];
    readonly events: readonly unknown[];
  };
}
export interface LocalEndpointContract {
  readonly source: EndpointContractSource;
  readonly document: ClusterDocument;
  readonly manifest: ReturnType<typeof buildContractClosureManifest>;
  readonly closureDigest: string;
  readonly commands: ReadonlyMap<string, { input: CompiledContract; output: CompiledContract }>;
}
const commandFields = ["name", "class", "targeted", "modes", "capability", "traits", "action", "admissionCeiling", "readinessDeadlineMs", "input", "output"];
function object(value: unknown, fields: readonly string[], coordinate: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((field) => !fields.includes(field))) throw invalid(coordinate, "expected a closed object without unknown fields");
  return value as Record<string, unknown>;
}
const invalid = (coordinate: string, message: string) => new CommandFailure("refused", "SCHEMA_INVALID", `endpoint contract ${coordinate}: ${message}; document values were not echoed`);
function schema(value: unknown, coordinate: string): SchemaBundle {
  const bundle = object(value, ["root", "members"], coordinate);
  if (!Object.hasOwn(bundle, "root")) throw invalid(coordinate, "a native schema bundle needs root");
  if (bundle.members !== undefined && (!bundle.members || typeof bundle.members !== "object" || Array.isArray(bundle.members))) throw invalid(coordinate, "members must be a digest-keyed object");
  return { root: bundle.root, ...(bundle.members === undefined ? {} : { members: bundle.members as Record<string, unknown> }) };
}

/** Compile local JSON with the installed native profile. No path, handler, broker or URL is opened. */
export function parseEndpointContract(raw: string): LocalEndpointContract {
  if (Buffer.byteLength(raw, "utf8") > MAX_ENDPOINT_CONTRACT_BYTES) throw invalid("$", "source exceeds 1 MiB");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw invalid("$", "source is not JSON"); }
  const source = object(input, ["schemaVersion", "endpoint", "cluster"], "$");
  if (source.schemaVersion !== 1 || typeof source.endpoint !== "string") throw invalid("$", "expected schemaVersion 1 and endpoint");
  try { endpointToken(source.endpoint); } catch { throw invalid("$.endpoint", "the native endpoint name is invalid"); }
  const cluster = object(source.cluster, ["urn", "revision", "attributes", "commands", "events"], "$.cluster");
  if (!Array.isArray(cluster.commands) || !cluster.commands.length || cluster.commands.length > 64) throw invalid("$.cluster.commands", "the local executable contract needs 1 to 64 commands");
  const inputs = cluster.commands.map((value, index) => object(value, commandFields, `$.cluster.commands[${index}]`));
  // Let the native parser decide classes, modes, actions, traits and admission fields before compiling.
  const declared = inputs.map(({ input: _input, output: _output, ...fields }) => ({ ...fields, inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST }));
  let document: ClusterDocument;
  try { document = parseClusterDocument({ ...cluster, commands: declared }); }
  catch { throw invalid("$.cluster", "the declaration is not supported by the installed native cluster parser"); }
  const commands = new Map<string, { input: CompiledContract; output: CompiledContract }>();
  for (const [index, command] of document.commands.entries()) {
    const definition = inputs[index]!;
    const compiled = {} as { input: CompiledContract; output: CompiledContract };
    for (const side of ["input", "output"] as const) {
      const coordinate = `$.cluster.commands[${index}].${side}`;
      const bundle = schema(definition[side], coordinate);
      try { compiled[side] = compileContract(bundle); }
      catch { throw invalid(coordinate, "schema compilation was refused by the installed native profile"); }
    }
    commands.set(command.name, compiled);
    command.inputDigest = compiled.input.closureDigest;
    command.outputDigest = compiled.output.closureDigest;
  }
  try {
    const manifest = buildContractClosureManifest(contractDigest(document), []);
    return { source: input as EndpointContractSource, document, manifest, closureDigest: contractDigest(manifest), commands };
  } catch { throw invalid("$.cluster", "cluster content is not interchangeable canonical JSON"); }
}

/** The scaffold declares one ordinary read-like echo command, not authority or a running service. */
export function endpointContractTemplate(name: string): EndpointContractSource {
  const endpoint = name.includes(".") ? name : `com.example.${name}`;
  try { endpointToken(endpoint); if (!isReverseDnsUrn(endpoint)) throw new Error(); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "init needs a lowercase DNS-shaped name or reverse-DNS endpoint name; it was not normalized"); }
  const payload = { type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string", maxLength: 4096 } } };
  return { schemaVersion: 1, endpoint, cluster: { urn: endpoint, revision: 1, attributes: [], events: [], commands: [{ name: "echo", class: "ephemeral", targeted: false, capability: "echo", input: { root: payload }, output: { root: payload } }] } };
}
