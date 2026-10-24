/**
 * Pure-function smoke for registry aliases and command declarations (no NATS).
 *
 * An alias resolves to its extension within that kind, and a name or alias that is already claimed
 * by a name or alias in the kind is refused at registration, live or staged, so which extension a
 * word resolves to never depends on load order. A command's own declarations refuse an alias equal
 * to its name and two subcommands sharing a word, and a subcommand resolves by name or alias.
 *
 * Run: pnpm --filter @cotal-ai/core test
 */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { commandDeclarationProblems, findCommand, findSubcommand, type Command } from "../src/command.js";
import { Registry } from "../src/registry.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const cmd = (name: string, extra: Partial<Command> = {}): Command => ({ kind: "command", name, summary: name, run: async () => {}, ...extra });

// An alias resolves to its extension; has() sees it; all() lists the extension once.
{
  const r = new Registry();
  r.register(cmd("spawn", { aliases: ["sp"] }));
  assert.equal(r.has("command", "sp"), true, "has() did not see an alias");
  assert.equal(r.resolve<Command>("command", "sp").name, "spawn", "an alias did not resolve to its command");
  assert.equal(r.all("command").length, 1);
  // Aliases are scoped to their kind.
  assert.throws(() => r.resolve("connector", "sp"), /no connector registered for "sp"/);
  r.register({ kind: "connector", name: "sp" });
  assert.equal(r.resolve("connector", "sp").name, "sp");
}

// A word already claimed in the kind is refused, whichever claim came first.
{
  const r = new Registry();
  r.register(cmd("spawn", { aliases: ["sp"] }));
  assert.throws(() => r.register(cmd("sp")), /already registered: command:sp/, "a name equal to a live alias registered");
  assert.throws(() => r.register(cmd("status", { aliases: ["spawn"] })), /already registered: command:spawn/, "an alias equal to a live name registered");
  assert.throws(() => r.register(cmd("send", { aliases: ["sp"] })), /already registered: command:sp/, "an alias equal to a live alias registered");
  assert.equal(r.has("command", "status"), false, "a refused registration left its name live");
  assert.equal(r.has("command", "send"), false);
}

// Within one call the whole batch is refused before any of it is applied.
{
  const r = new Registry();
  assert.throws(() => r.register(cmd("a1", { aliases: ["x"] }), cmd("a2", { aliases: ["x"] })), /already registered: command:x/);
  assert.equal(r.has("command", "a1"), false, "a refused batch applied its first entry");
  assert.throws(() => r.register(cmd("a3", { aliases: ["y", "y"] })), /already registered: command:y/, "a repeated alias registered");
}

// A staged registration claims its aliases against the live registry and against the stage, and a
// commit re-checks them against what went live in the meantime.
{
  const r = new Registry();
  r.register(cmd("ext", { aliases: ["x"] }));
  await assert.rejects(r.runStaged(async () => r.register(cmd("xx", { aliases: ["x"] }))), /already registered: command:x/);
  await assert.rejects(
    r.runStaged(async () => {
      r.register(cmd("one", { aliases: ["o"] }));
      r.register(cmd("o"));
    }),
    /already registered: command:o/,
    "a staged alias did not block a name staged after it",
  );
  const { staged } = await r.runStaged(async () => r.register(cmd("history", { aliases: ["h"] })));
  assert.equal(r.has("command", "h"), false, "a staged alias resolved before commit");
  r.register(cmd("help", { aliases: ["h"] }));
  assert.throws(() => r.commitStaged(staged), /already registered: command:h/, "a commit published an alias claimed after staging");
  assert.equal(r.resolve<Command>("command", "h").name, "help");
}

// Unregistering frees the name and its aliases.
{
  const r = new Registry();
  r.register(cmd("attach", { aliases: ["a"] }));
  assert.equal(r.unregister("command", "attach"), true);
  assert.equal(r.has("command", "a"), false, "an unregistered command's alias still resolved");
  assert.doesNotThrow(() => r.register(cmd("a")), "an unregistered command's alias was still claimed");
}

// A command's own declarations.
{
  assert.deepEqual(commandDeclarationProblems(cmd("ext", { aliases: ["x"], subcommands: [{ name: "add", summary: "" }, { name: "remove", summary: "", aliases: ["rm"] }] })), []);
  assert.deepEqual(commandDeclarationProblems(cmd("ext", { aliases: ["ext"] })), ['command "ext" lists its own name as an alias'], "an alias equal to its command's name was accepted");
  assert.deepEqual(
    commandDeclarationProblems(cmd("ext", { subcommands: [{ name: "remove", summary: "", aliases: ["rm"] }, { name: "rm", summary: "" }] })),
    ['command "ext": "rm" names both subcommand remove and rm'],
    "two subcommands sharing a word were accepted",
  );
  const ext = cmd("ext", { subcommands: [{ name: "remove", summary: "", aliases: ["rm"] }] });
  assert.equal(findSubcommand(ext, "rm")?.name, "remove");
  assert.equal(findSubcommand(ext, "remove")?.name, "remove");
  assert.equal(findSubcommand(ext, "re"), undefined, "a prefix selected a subcommand");
  assert.equal(findSubcommand(ext, undefined), undefined);
  const surface = [cmd("spawn", { aliases: ["sp"] }), cmd("status", { aliases: ["s"] })];
  assert.equal(findCommand(surface, "sp")?.name, "spawn");
  assert.equal(findCommand(surface, "status")?.name, "status");
  assert.equal(findCommand(surface, "spa"), undefined, "a prefix selected a command");
  assert.equal(findCommand(surface, undefined), undefined);
}

console.log("registry-aliases.smoke: all assertions passed");
emitSentinel({ passed: cells(), failed: 0 });
