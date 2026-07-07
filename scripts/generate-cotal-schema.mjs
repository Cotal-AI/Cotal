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

if (!part?.anyOf || part.anyOf.length !== 4) {
  throw new Error("expected Part to generate core text, core data, core view, and extension variants");
}
part.oneOf = part.anyOf;
delete part.anyOf;

if (!extensionPartKind) {
  throw new Error("expected ExtensionPartKind definition");
}
extensionPartKind.pattern = "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$";

writeFileSync("spec/cotal.schema.json", `${JSON.stringify(schema, null, 2)}\n`);
