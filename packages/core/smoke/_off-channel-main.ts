import { readFileSync } from "node:fs";

export const recordOffChannelPermissions = process.argv.includes("--record-off-channel-permissions");
export function matchesMainPermissions(name: string, observed: unknown): boolean {
  if (recordOffChannelPermissions) {
    console.log(`OFF_CHANNEL_${name}=${JSON.stringify(observed)}`);
    return true;
  }
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/off-channel-permissions-main.json", import.meta.url), "utf8")) as Record<string, unknown>;
  return JSON.stringify(observed) === JSON.stringify(fixture[name]);
}
