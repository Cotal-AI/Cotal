import { eventChannel } from "@cotal-ai/connector-core";
import { piConnector } from "../src/connector.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) pass++;
  else {
    fail++;
    console.log(`  x FAIL: ${name}`, extra ?? "");
  }
};

const root = "/tmp/cotal-pi-events-workspace";
const env = (extra: Record<string, unknown>): Record<string, string> =>
  piConnector.buildLaunch({ space: "s", name: "seat", ...extra } as never).env as Record<string, string>;
const refusalFor = (extra: Record<string, unknown>): string | null => {
  try {
    env(extra);
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
};

{
  const plain = env({ workspaceRoot: root });
  check("an unarmed Pi launch sets no COTAL_EVENTS", plain.COTAL_EVENTS === undefined, plain.COTAL_EVENTS);
  check("an unarmed Pi launch sets no event workspace root", plain.COTAL_WORKSPACE_ROOT === undefined, plain.COTAL_WORKSPACE_ROOT);
}

{
  const armed = env({ events: true, workspaceRoot: root });
  check("--events arms the Pi emitter", armed.COTAL_EVENTS === "1", armed.COTAL_EVENTS);
  check("an armed Pi launch carries the WAL workspace root", armed.COTAL_WORKSPACE_ROOT === root, armed.COTAL_WORKSPACE_ROOT);
}

{
  const unarmed = env({ events: false, workspaceRoot: root });
  check("events false leaves the plane unarmed", unarmed.COTAL_EVENTS === undefined, unarmed.COTAL_EVENTS);
  const grantOnly = env({ workspaceRoot: root, allowPublish: [eventChannel({ owner: "o", actor: "a" })] });
  check("a publish grant alone never arms the emitter", grantOnly.COTAL_EVENTS === undefined, grantOnly.COTAL_EVENTS);
}

{
  const refusal = refusalFor({ events: true });
  check("an armed Pi launch without workspace root refuses", refusal !== null, refusal);
  check("the refusal names the event write-ahead log", /event write-ahead log/.test(refusal ?? ""), refusal);
}

{
  check("the Pi connector declares an event plane", typeof piConnector.eventChannel === "function", piConnector.eventChannel);
  check(
    "the connector event channel is connector-core's derivation by identity",
    piConnector.eventChannel === eventChannel,
    { connector: piConnector.eventChannel, core: eventChannel },
  );
}

const expected = 10;
check(`every cell ran (${expected})`, pass + fail === expected, { pass, fail });
console.log(`pi-events-arm smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
