import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const raw = execFileSync(
  "pnpm",
  [
    "exec",
    "ts-json-schema-generator",
    "-p",
    "packages/core/src/types.ts",
    "-t",
    "CotalMessage",
    "--additional-properties",
  ],
  { encoding: "utf8" },
);

const schema = JSON.parse(raw);
const definitions = schema.definitions ?? {};
const message = definitions.CotalMessage;
const part = definitions.Part;
const extensionPartKind = definitions.ExtensionPartKind;

if (!message?.anyOf || message.anyOf.length !== 3) {
  throw new Error("expected CotalMessage to generate three routing variants");
}

const routes = ["channel", "to", "toService"];
for (const variant of message.anyOf) {
  const required = variant.required ?? [];
  const route = routes.find((field) => required.includes(field));
  if (!route) throw new Error("CotalMessage variant is missing a required route field");
  const forbidden = routes.filter((field) => field !== route);
  variant.not = { anyOf: forbidden.map((field) => ({ required: [field] })) };
}
message.oneOf = message.anyOf;
delete message.anyOf;

// One variant per CORE kind plus the reverse-DNS extension variant. The count is asserted rather
// than inferred so adding a core kind cannot silently skip the `oneOf` conversion below — which is
// what makes the variants mutually exclusive instead of merely permitted.
const PART_VARIANTS = 4; // text, data, artifact, extension
if (!part?.anyOf || part.anyOf.length !== PART_VARIANTS) {
  throw new Error(`expected Part to generate ${PART_VARIANTS} variants (text, data, artifact, extension), got ${part?.anyOf?.length}`);
}
// The schema is AUTHORITATIVE for message shapes (SPEC §5), so it must not be looser than the
// runtime guard — a schema admitting `digest: "banana"` while `isArtifactPart` refuses it means the
// two disagree about what a conformant message is, and the spec says the schema wins. TypeScript
// cannot express either constraint, so both are pinned here, the same way ExtensionPartKind's
// pattern is below.
const artifactPart = part.anyOf.find((v) => v.properties?.kind?.const === "artifact");
if (!artifactPart) throw new Error("expected an artifact Part variant");
artifactPart.properties.digest.pattern = "^sha256:[0-9a-f]{64}$";
artifactPart.properties.size.type = "integer";
artifactPart.properties.size.minimum = 0;

part.oneOf = part.anyOf;
delete part.anyOf;

if (!extensionPartKind) {
  throw new Error("expected ExtensionPartKind definition");
}
extensionPartKind.pattern = "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$";

writeFileSync("spec/cotal.schema.json", `${JSON.stringify(schema, null, 2)}\n`);
