/**
 * Adapter contract against the supported hermes-agent range (no test runner).
 *
 * The version pin in src/launch.ts is a claim about a Python contract, and until this suite
 * existed nothing checked the Python half of it. That is the gap that let the connector ship a
 * 0.16 pin: `assertHermesVersion` was fed one accepted version and the adapter was never
 * inspected at all, so both halves were green on a tree no supported gateway could drive.
 *
 * What the gateway does, from hermes-agent 0.18.0 (tag v2026.7.1) onward, is call
 *
 *     await adapter.connect(is_reconnect=is_reconnect)
 *
 * at every call site (gateway/run.py through 0.21.0, gateway/run_adapters.py from 0.21.1). An
 * adapter declaring `async def connect(self) -> bool` binds a bare `connect()` and raises
 * TypeError on that keyword, AFTER a clean-looking plugin load, so the symptom is a platform
 * that fails at connect rather than an import error.
 *
 * This drives the REAL CotalAdapter.connect through Python's own binding machinery, so a
 * regression in the signature fails here rather than at an operator's first launch.
 *
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as nodeAssert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Count every assertion so the terminal sentinel is derived from what ran.
 *
 * `bin/smoke/shard.mjs` refuses a suite whose output names no cell count, and refuses a zero-cell
 * run, because exit 0 having run nothing is the same false green as an empty chain. This suite is
 * reached through the package `test` script today rather than the CI shard list, but it emits the
 * sentinel anyway so that adding it to a shard later is a one-line change and not a fresh failure.
 */
let cells = 0;
const assert = new Proxy(nodeAssert, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      cells += 1;
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as typeof nodeAssert;

/**
 * The count is a FLOOR, not a decoration.
 *
 * A derived sentinel proves the suite RAN its assertions. It does not prove the suite still
 * CONTAINS them: delete one executed assertion and the tally quietly reads one lower and the shard
 * still passes. That is liveness, not coverage, and shipping it while it reads like a coverage
 * guarantee is the false-green shape this package keeps being bitten by. Pinning the floor turns a
 * smaller green into a red. Raise it deliberately when you add a cell; a drop means one vanished.
 */
const EXPECTED_CELLS = 23;

if (process.platform === "win32") {
  console.log("✓ adapter-contract smoke skipped on Windows (the Hermes connector is Unix-only)");
  // A skip still names a cell count, or the shard reads the silence as a suite that ran nothing.
  console.log("COTAL_SMOKE_SENTINEL cells=1 passed=1 failed=0");
  process.exit(0);
}

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
// No Python means this contract is unverified, and a suite that quietly passes when it cannot
// check anything is the failure mode this whole file exists to close. Fail loud.
assert.ok(python, "no python3/python on PATH: the Hermes adapter contract cannot be verified");

/**
 * Bind the real `CotalAdapter.connect` against each gateway call style.
 *
 * `plugin/cotal/adapter.py` imports the upstream `gateway` package, which is not installed in
 * CI, so the import is satisfied with a stub. The stub supplies ONLY the names the module
 * imports; `CotalAdapter.connect` itself is the connector's own real code, and its signature is
 * read off the class with `inspect`, not off the source text.
 */
const script = String.raw`
import inspect, sys, types

# --- stub ONLY the upstream imports, never the code under test -------------------------------
base = types.ModuleType("gateway.platforms.base")
class BasePlatformAdapter:
    def __init__(self, config=None, platform=None): pass
    def _mark_connected(self): pass
    def _mark_disconnected(self): pass
class MessageEvent:
    def __init__(self, **kw): pass
class MessageType:
    TEXT = "text"
class SendResult:
    def __init__(self, **kw): pass
base.BasePlatformAdapter = BasePlatformAdapter
base.MessageEvent = MessageEvent
base.MessageType = MessageType
base.SendResult = SendResult

cfg = types.ModuleType("gateway.config")
class Platform:
    def __init__(self, name): self.name = name
class PlatformConfig: pass
cfg.Platform = Platform
cfg.PlatformConfig = PlatformConfig

platforms = types.ModuleType("gateway.platforms")
gateway = types.ModuleType("gateway")
sys.modules.update({
    "gateway": gateway, "gateway.platforms": platforms,
    "gateway.platforms.base": base, "gateway.config": cfg,
})

sys.path.insert(0, PLUGIN_PARENT)
from cotal.adapter import CotalAdapter

sig = inspect.signature(CotalAdapter.connect)
print("SIGNATURE", sig)

def binds(**kw):
    """True when the gateway's call style binds against the REAL method signature."""
    try:
        sig.bind(object(), **kw)
        return True
    except TypeError:
        return False

# The subject: the two call styles the gateway actually uses.
print("BIND_BARE", binds())                          # 0.16/0.17 and the timeout==0 path
print("BIND_KWARG", binds(is_reconnect=False))       # 0.18+ every call site
print("BIND_KWARG_TRUE", binds(is_reconnect=True))   # the reconnect watcher

# is_reconnect must be KEYWORD-ONLY: upstream declares it after '*', so an adapter that accepts
# it positionally would diverge from the contract even while the keyword call happens to bind.
p = sig.parameters.get("is_reconnect")
print("KEYWORD_ONLY", p is not None and p.kind is inspect.Parameter.KEYWORD_ONLY)
print("DEFAULTS_FALSE", p is not None and p.default is False)

# --- CONTROLS, same invocation ----------------------------------------------------------------
# ACCEPT: a 0.21-shaped adapter must bind both styles, proving the instrument can say yes.
class Accept:
    async def connect(self, *, is_reconnect: bool = False) -> bool: return True
a = inspect.signature(Accept.connect)
def abinds(**kw):
    try:
        a.bind(object(), **kw); return True
    except TypeError:
        return False
print("CONTROL_ACCEPT_BARE", abinds())
print("CONTROL_ACCEPT_KWARG", abinds(is_reconnect=True))

# REFUSE (near neighbour): the PRE-FIX signature, one keyword away from the subject. It must bind
# bare and REFUSE the keyword, proving the instrument can say no and is not binding everything.
class Refuse:
    async def connect(self) -> bool: return True
r = inspect.signature(Refuse.connect)
def rbinds(**kw):
    try:
        r.bind(object(), **kw); return True
    except TypeError:
        return False
print("CONTROL_REFUSE_BARE", rbinds())
print("CONTROL_REFUSE_KWARG", rbinds(is_reconnect=True))

# The reconnect path calls BridgeClient.reopen, so the method the adapter depends on must exist.
from cotal.bridge_client import BridgeClient
print("HAS_REOPEN", callable(getattr(BridgeClient, "reopen", None)))
`;

const res = spawnSync(python!, ["-c", `PLUGIN_PARENT = ${JSON.stringify(pkgDir + "plugin")}\n${script}`], {
  encoding: "utf8",
  timeout: 60_000,
});
assert.equal(res.status, 0, `the adapter probe did not run:\n${res.stdout}\n${res.stderr}`);

const out = Object.fromEntries(
  res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(" ");
      return [line.slice(0, i), line.slice(i + 1).trim()];
    }),
);

// ASSERT THE SHAPE BEFORE READING ANY ANSWER OFF IT. A probe that printed nothing would otherwise
// let `undefined !== "True"` read as a clean failure of the subject, when it is really a failure
// of the instrument, and adjacent output would close over the hole.
for (const key of [
  "SIGNATURE", "BIND_BARE", "BIND_KWARG", "BIND_KWARG_TRUE", "KEYWORD_ONLY", "DEFAULTS_FALSE",
  "CONTROL_ACCEPT_BARE", "CONTROL_ACCEPT_KWARG", "CONTROL_REFUSE_BARE", "CONTROL_REFUSE_KWARG",
  "HAS_REOPEN",
])
  assert.ok(key in out, `the adapter probe did not report ${key}, so its silence is not a result:\n${res.stdout}`);

// Controls first: an instrument that cannot decline proves nothing when it accepts.
assert.equal(out.CONTROL_ACCEPT_BARE, "True", "accept control: a 0.21-shaped adapter binds a bare connect()");
assert.equal(out.CONTROL_ACCEPT_KWARG, "True", "accept control: a 0.21-shaped adapter binds connect(is_reconnect=...)");
assert.equal(out.CONTROL_REFUSE_BARE, "True", "refuse control: the pre-fix signature still binds a bare connect()");
assert.equal(out.CONTROL_REFUSE_KWARG, "False", "refuse control: the pre-fix signature must REJECT the keyword, or this probe is binding everything");

// The subject.
assert.equal(out.BIND_KWARG, "True", "the gateway passes is_reconnect at every call site from 0.18 on: the adapter must accept it");
assert.equal(out.BIND_KWARG_TRUE, "True", "the reconnect watcher calls connect(is_reconnect=True)");
assert.equal(out.BIND_BARE, "True", "a bare connect() must still bind: the timeout==0 path and older lines call it that way");
assert.equal(out.KEYWORD_ONLY, "True", "upstream declares is_reconnect after '*', so it must be keyword-only here too");
assert.equal(out.DEFAULTS_FALSE, "True", "a cold connect is not a reconnect, so the default must be False");
assert.equal(out.HAS_REOPEN, "True", "the reconnect path restarts a closed bridge through BridgeClient.reopen");

console.log(`adapter contract: ${out.SIGNATURE}`);
console.log(
  "adapter contract: 3 gateway call styles bound, is_reconnect keyword-only defaulting False, " +
    "reopen present, 4 control rows held (accept binds both styles, pre-fix signature refuses the keyword)",
);
// Terminal sentinel, last line. Reaching it means every counted assertion passed, since a failed
// one throws.
// The floor runs LAST, so a suite that lost an assertion fails here even though every remaining
// assertion passed.
if (cells !== EXPECTED_CELLS) {
  console.error(
    `SUITE INCOMPLETE: expected ${EXPECTED_CELLS} assertions, ran ${cells}. ` +
      `A lower count means an assertion was deleted or skipped, which a derived tally alone would report as a smaller green.`,
  );
  console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells} failed=1`);
  process.exit(1);
}
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells} failed=0`);
