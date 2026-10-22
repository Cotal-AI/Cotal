import { readFileSync } from "node:fs";

// Decode the `nats` permission block out of a minted creds file (the JWT is the first line after the
// BEGIN marker; its middle segment is base64url JSON).
export function credAcl(path: string): { sub: string[]; pub: string[] } {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  const nats = claims.nats ?? {};
  const chat = (arr: string[] | undefined, keepJs: boolean) =>
    (arr ?? []).filter((s) => s.includes(".chat.") && (keepJs || !s.startsWith("$JS")));
  return { sub: chat(nats.sub?.allow, true), pub: chat(nats.pub?.allow, false) };
}
