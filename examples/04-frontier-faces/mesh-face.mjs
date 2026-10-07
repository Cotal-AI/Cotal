// mesh-face.mjs — example-local launcher: a mesh OpenCode peer rendered as its animated face.
//
// The seat is the OpenCode connector's own: `launch` (extensions/connector-opencode/dist/launch.js)
// runs the connector's lifecycle (free port, per-launch server password, per-agent SQLite DB,
// `[cotal-session]` handshake, teardown) and attaches whatever TUI its caller names, so the connector
// stays face-agnostic and a lifecycle fix there reaches the faces too. This example adds two steps:
//   • composes the agent's persona with a face-steering block (so the agent drives its expression by
//     calling the face_<mood> tools from face-plugin.mjs — which face-term reads off the session
//     event stream — while its cotal_send/cotal_dm messages stay clean on the wire and console);
//   • attaches `node face-term.mjs --persona … --server … --session …` as that TUI.
//
// Env (set by mesh-face.sh): COTAL_OPENCODE_HOME (data root, required), COTAL_NAME, COTAL_AGENT_FILE,
// FACE_PERSONA (face-term persona key), FACE_BIN (path to face-term.mjs), OPENCODE_CONFIG_CONTENT
// (the inline opencode config with the Cotal plugin). COTAL_OPENCODE_BIN overrides the opencode bin.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { launch } from "../../extensions/connector-opencode/dist/launch.js";

// The face-steering block appended to the agent's persona. Expression rides the `face_<mood>` tools
// (from face-plugin.mjs), NOT the message text — so it obeys the personas' "answer only through
// tools" rule with no contradiction, and the de-leak's clean wire/console is preserved (face-term
// reads the tool call off the session event stream; peers and the console never see any markup).
const FACE_STEER = [
  "## Expressing emotion (face viewer)",
  "You are rendered as an animated pixel-art face. Drive its expression with your face tools: call",
  "face_happy / face_sad / face_angry / face_surprised / face_neutral the moment your mood shifts to",
  "match. These only animate your avatar — they are not messages and no peer sees them, so they fit",
  "'answer only through tools' perfectly while keeping your cotal_send / cotal_dm / cotal_anycast",
  "text clean. Never describe your expression inside the messages themselves.",
].join("\n");

async function main() {
  const name = process.env.COTAL_NAME?.trim() || "agent";
  const persona = process.env.FACE_PERSONA?.trim() || name;
  const faceBin = process.env.FACE_BIN?.trim();
  if (!faceBin) throw new Error("FACE_BIN is not set — point it at face-term.mjs");
  const agentFile = process.env.COTAL_AGENT_FILE?.trim();
  if (!agentFile) throw new Error("COTAL_AGENT_FILE is not set — the launcher must pass the persona file");

  // Compose persona + face-steering into a launch-local agent file beside the agent's DB (the
  // connector no longer injects any face prompt); the plugin inside the server reads it through
  // COTAL_AGENT_FILE. Same frontmatter ⇒ identity/ACLs are unchanged.
  await launch(
    ({ url, session }) => [process.execPath, faceBin, "--persona", persona, "--server", url, "--session", session],
    (agentHome) => {
      const composedFile = join(agentHome, basename(agentFile));
      writeFileSync(composedFile, `${readFileSync(agentFile, "utf8").trimEnd()}\n\n${FACE_STEER}\n`);
      return { COTAL_AGENT_FILE: composedFile };
    },
  );
}

void main();
