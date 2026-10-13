/**
 * Build the Discord webhook payload that announces a GitHub Release. The embed carries the
 * `## What changed` layer of the release body (one sentence per change, as
 * `scripts/release-notes-detail.mjs` writes it) under the upgrade command, with a link to the
 * Release for everything else. It never carries the full changeset text: Discord caps an embed
 * description at 4096 characters and a wall of text is not an announcement.
 *
 * Usage: node scripts/release-announcement.mjs <tag> <release url> < release-body.md > payload.json
 *
 * Refuses a body with no `## What changed` section rather than posting something else.
 * `--self-test` runs the suite at the bottom of this file.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DESCRIPTION_LIMIT = 4096;

/** The bullet lines of the `## What changed` section, up to the next header or collapsed block. */
export const whatChanged = (body) => {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf("## What changed");
  if (start === -1) throw new Error("release body has no `## What changed` section");
  const bullets = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ") || line.startsWith("<details>")) break;
    if (line.startsWith("- ")) bullets.push(line);
  }
  if (bullets.length === 0) throw new Error("the `## What changed` section lists no change");
  return bullets;
};

export const payload = (tag, url, body) => {
  const version = tag.replace(/^v/, "");
  const bullets = whatChanged(body);
  const head = `Upgrade: \`npm i -g cotal-ai@${version}\`\n\n`;
  const more = (n) => `\n…and ${n} more on the release page.`;
  let shown = bullets.length;
  let description = head + bullets.join("\n");
  while (description.length > DESCRIPTION_LIMIT) {
    shown -= 1;
    description = head + bullets.slice(0, shown).join("\n") + more(bullets.length - shown);
  }
  return {
    content: "||@everyone||",
    username: "Cotal releases",
    embeds: [{ title: `Cotal ${version} is out`, url, description, color: 2105893 }],
  };
};

/** Run this script's CLI with the body written as the given byte chunks and return its stdout. */
const runCli = (chunks) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "v1.0.0", "u"], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    const write = (n) => {
      if (n === chunks.length) return child.stdin.end();
      child.stdin.write(chunks[n], () => setTimeout(() => write(n + 1), 20));
    };
    write(0);
  });

const selfTest = async () => {
  const body = [
    "**Cotal 0.81.1 is out.**",
    "",
    "## What changed",
    "",
    "- A seat never leaves the mesh because its event plane stopped.",
    "- `cotal spawn -f` now reports a failed launch as partial.",
    "",
    "<details>",
    "<summary>Every change in full</summary>",
    "",
    "- A seat never leaves the mesh because its event plane stopped. Much more text.",
    "",
    "</details>",
    "",
    "## What's Changed",
    "* fix: something by @someone in https://github.com/Cotal-AI/Cotal/pull/1",
  ].join("\n");
  const p = payload("v0.81.1", "https://github.com/Cotal-AI/Cotal/releases/tag/v0.81.1", body);
  assert.equal(p.embeds[0].title, "Cotal 0.81.1 is out");
  assert.equal(p.embeds[0].url, "https://github.com/Cotal-AI/Cotal/releases/tag/v0.81.1");
  assert.equal(
    p.embeds[0].description,
    "Upgrade: `npm i -g cotal-ai@0.81.1`\n\n- A seat never leaves the mesh because its event plane stopped.\n- `cotal spawn -f` now reports a failed launch as partial.",
    "the embed carries the upgrade command and the one-sentence layer only",
  );
  assert.equal(p.content, "||@everyone||");

  const long = ["## What changed", "", ...Array.from({ length: 60 }, (_, i) => `- Change number ${i} ${"x".repeat(90)}.`)].join("\n");
  const capped = payload("v1.0.0", "u", long).embeds[0].description;
  assert.ok(capped.length <= DESCRIPTION_LIMIT, "the description stays within Discord's limit");
  assert.ok(/\n…and \d+ more on the release page\.$/.test(capped), "a cut list says how many changes it left out");
  assert.ok(capped.includes("- Change number 0 "), "whole bullets are dropped from the end, the first stays");
  assert.ok(!/\n- Change number \d+ x+$/.test(capped.replace(/\n…and.*$/, "x")), "no bullet is cut mid-line");

  assert.throws(() => payload("v1.0.0", "u", "**Cotal 1.0.0 is out.**\n\n## What's Changed\n* a"), /no `## What changed` section/);
  assert.throws(() => payload("v1.0.0", "u", "## What changed\n\n<details>\n- hidden\n</details>"), /lists no change/);

  const bytes = Buffer.from("## What changed\n- Safe reconnect \u{1F504}.\n", "utf8");
  const cut = bytes.indexOf(Buffer.from([0xf0, 0x9f, 0x94, 0x84])) + 2;
  const streamed = JSON.parse(await runCli([bytes.subarray(0, cut), bytes.subarray(cut)]));
  assert.equal(streamed.embeds[0].description, "Upgrade: `npm i -g cotal-ai@1.0.0`\n\n- Safe reconnect \u{1F504}.", "a code point split across stdin chunks decodes whole");
  console.log("release-announcement self-test: ok");
};

const main = async (argv) => {
  if (argv[0] === "--self-test") return await selfTest();
  const [tag, url] = argv;
  if (!tag || !url) {
    process.stderr.write("usage: release-announcement.mjs <tag> <release url> < release-body.md\n");
    process.exit(1);
  }
  process.stdin.setEncoding("utf8"); // a multi-byte code point split across chunks decodes whole
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  process.stdout.write(JSON.stringify(payload(tag, url, body)));
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main(process.argv.slice(2));
