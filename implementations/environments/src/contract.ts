import { contractDigest, EpEnvelopeError, serviceContractTable, type EpCommandDef } from "@cotal-ai/core";
import type { EnvironmentService } from "./service.js";
import { ENVIRONMENT_RECORD_SCHEMA, ENVIRONMENT_REFERENCE_SCHEMA } from "./store.js";

const ID = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const SELECT = { type: "object", additionalProperties: false, required: ["id"], properties: { id: ID } } as const;
const VIEW = {
  type: "object", additionalProperties: false, required: ["record"],
  properties: {
    record: ENVIRONMENT_RECORD_SCHEMA,
    problem: { enum: ["create-unconfirmed", "observation-unavailable", "retention-unconfirmed", "retirement-pending"] },
    cleanup: {
      type: "object", additionalProperties: false, required: ["retention", "retirement"],
      properties: { retention: { enum: ["pending", "retained", "unknown"] }, retirement: { enum: ["pending", "retired"] } },
    },
    observation: {
      type: "object", additionalProperties: false, required: ["environment", "state", "observedAt"],
      properties: {
        environment: ENVIRONMENT_REFERENCE_SCHEMA,
        state: { enum: ["creating", "running", "paused", "terminating", "terminated", "unknown"] },
        observedAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
  },
} as const;
const ROWS = [
  {
    name: "create", capability: "environment.write",
    input: {
      type: "object", additionalProperties: false, required: ["operationId", "profile", "profileDigest"],
      properties: {
        operationId: { type: "string", pattern: "^[A-Za-z0-9_-]{16,64}$" },
        profile: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
        profileDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
    },
    output: VIEW,
  },
  { name: "inspect", capability: "environment.read", input: SELECT, output: VIEW },
  { name: "destroy", capability: "environment.write", input: {
    ...SELECT, properties: { ...SELECT.properties, force: { type: "boolean" } },
  }, output: VIEW },
];
const TABLE = serviceContractTable(ROWS);
const closure = (value: unknown): string => contractDigest({ v: 1, root: contractDigest(value), members: [] });

export function environmentClusterArtifacts() {
  const document = {
    urn: "ai.cotal.environment", revision: 1, attributes: [], events: [],
    commands: ROWS.map((r) => ({ name: r.name, class: "ephemeral", targeted: false, capability: r.capability,
      inputDigest: closure(r.input), outputDigest: closure(r.output) })),
  };
  const rootDigest = contractDigest(document);
  const manifest = { v: 1, root: rootDigest, members: [] };
  return { document, rootDigest, manifest, closureDigest: contractDigest(manifest),
    artifacts: [...TABLE.artifactValues(), document, manifest] };
}

/** Owner identity is taken solely from the authenticated subject. No payload field can override it.
 * Provisioning is an idempotent bounded call, not a Cotal action or a claim of manager readiness. */
export function environmentCommandDefs(service: EnvironmentService): EpCommandDef[] {
  return ROWS.map((row) => ({
    command: row.name,
    contract: TABLE.contracts[row.name],
    handler: async (ctx) => {
      const caller = ctx.subject.caller;
      const args = ctx.request.args as { id: string; operationId: string; profile: string; profileDigest: string; force?: boolean };
      try {
        switch (row.name) {
          case "create": return await service.create(caller, args);
          case "inspect": return await service.inspect(caller, args.id);
          case "destroy": return await service.destroy(caller, args.id, args.force);
          default: throw new Error("unknown environment command");
        }
      } catch (error) {
        if (error instanceof EpEnvelopeError) throw error;
        // Provider, store and host callback diagnostics can contain private material.
        throw new EpEnvelopeError("unavailable", "environment operation could not be confirmed; inspect its recorded state", undefined, "unknown");
      }
    },
  }));
}
