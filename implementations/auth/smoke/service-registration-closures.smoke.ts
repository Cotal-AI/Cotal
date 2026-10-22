/** Broker-free suite for the closures a service registration may carry. A declared command's schema
 * closure travels with its cluster closure and is compiled to exactly the command's digest; one left
 * out is assumed to be in the contract store; anything else is refused as before. */
import { buildContractClosureManifest, contractDigest, singleDocumentClosure, VOID_SCHEMA_DIGEST } from "@cotal-ai/core";
import { compileServiceRegistration, ServiceRegistrationRefusal } from "../src/service-endpoint-authority.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };
const refusal = (f: () => unknown): string | undefined => {
  try { f(); return undefined; } catch (e) { return e instanceof ServiceRegistrationRefusal ? e.reason : `other: ${(e as Error).message}`; }
};

// A schema closure with one member, referenced by digest from its root.
const member = { type: "string", maxLength: 64 };
const root = { type: "object", additionalProperties: false, properties: { name: { $ref: `cotal:${contractDigest(member)}` } } };
const schemaManifest = buildContractClosureManifest(contractDigest(root), [contractDigest(member)]);
const schemaDigest = contractDigest(schemaManifest);
// A single-document schema closure for the output.
const outRoot = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] };
const out = singleDocumentClosure(outRoot);

const document = { urn: "org.example.lookup", revision: 1, attributes: [], events: [],
  commands: [{ name: "lookup", class: "ephemeral", targeted: false, capability: "read", inputDigest: schemaDigest, outputDigest: out.closureDigest },
    { name: "ping", class: "ephemeral", targeted: false, capability: "read", inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST }] };
const cluster = singleDocumentClosure(document);
const reg = (extra: unknown[]) => ({ clusterDigests: [cluster.closureDigest], contractArtifacts: [cluster.manifest, document, ...extra] });

const full = compileServiceRegistration(reg([schemaManifest, root, member, out.manifest, outRoot]));
check("a registration carrying its commands' schema closures compiles both commands",
  full.commands.map((c) => c.name).join() === "lookup,ping" && full.commands[0].inputDigest === schemaDigest && full.commands[0].outputDigest === out.closureDigest, full.commands);
const bare = compileServiceRegistration(reg([]));
check("a registration without them still compiles, leaving the schemas to the contract store", bare.commands.length === 2, bare.commands);
check("one schema closure may travel without the other", compileServiceRegistration(reg([out.manifest, outRoot])).commands.length === 2);
check("a schema closure missing a member is refused as closure-invalid", refusal(() => compileServiceRegistration(reg([schemaManifest, root]))) === "closure-invalid");
check("a schema closure missing its root is refused as closure-invalid", refusal(() => compileServiceRegistration(reg([schemaManifest, member]))) === "closure-invalid");
check("a schema root sent without its manifest belongs to no declared closure", refusal(() => compileServiceRegistration(reg([outRoot]))) === "closure-invalid");
check("an artifact no declared command names is refused as before", refusal(() => compileServiceRegistration(reg([{ type: "number" }]))) === "closure-invalid");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
