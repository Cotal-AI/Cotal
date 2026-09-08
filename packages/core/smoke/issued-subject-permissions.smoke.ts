import assert from "node:assert/strict";
import {
  exportNativeSubjectPermission,
  importNativeSubjectPermissions,
  permitsSubject,
  readSubjectPermission,
  requestedSubjectPermission,
} from "./prototypes/issued-subject-permissions.js";

let passed = 0;
function check(name: string, run: () => void): void {
  try { run(); }
  catch (error) {
    console.error(`  FAIL: ${name}`);
    throw error;
  }
  passed++;
  console.log(`  ok ${name}`);
}

for (const native of [{}, { pub: {} }, { pub: { allow: [] } }, { pub: { deny: [] } }]) {
  check(`native empty forms remain unrestricted: ${JSON.stringify(native)}`, () => {
    const p = importNativeSubjectPermissions(native);
    assert.equal(p.publish.allow.mode, "all");
    assert(permitsSubject(p.publish, "orders.public"));
    assert(permitsSubject(p.publish, "orders.private"));
  });
}
check("an empty requested scope is denied and exports explicit deny-all", () => {
  const p = requestedSubjectPermission([]);
  assert.equal(p.allow.mode, "none");
  assert.equal(permitsSubject(p, "orders.public"), false);
  assert.deepEqual(exportNativeSubjectPermission(p), { allow: [">"], deny: [">"] });
});
check("denies override listed or unrestricted native allows", () => {
  for (const pub of [{ allow: ["orders.>"], deny: ["orders.private"] }, { deny: ["orders.private"] }]) {
    const p = importNativeSubjectPermissions({ pub }).publish;
    assert(permitsSubject(p, "orders.public"));
    assert.equal(permitsSubject(p, "orders.private"), false);
  }
});
check("publish and subscribe are independent", () => {
  const p = importNativeSubjectPermissions({ pub: { deny: [">"] }, sub: { allow: ["orders.*"] } });
  assert.equal(permitsSubject(p.publish, "orders.public"), false);
  assert(permitsSubject(p.subscribe, "orders.public"));
  assert.equal(permitsSubject(p.subscribe, "orders.public.extra"), false);
});
check("wildcards retain native one-token and one-or-more semantics", () => {
  const p = requestedSubjectPermission(["orders.>", "$JS.API.INFO"]);
  assert.equal(permitsSubject(p, "orders"), false);
  assert(permitsSubject(p, "orders.a.b"));
  assert(permitsSubject(p, "$JS.API.INFO"));
  assert.equal(permitsSubject(p, "$JS.API.STREAM.CREATE"), false);
});
check("normalization snapshots and deep-freezes caller input", () => {
  const allow = ["orders.public"], deny: string[] = [];
  const p = requestedSubjectPermission(allow, deny);
  allow.push(">"); deny.push("orders.public");
  assert(permitsSubject(p, "orders.public"));
  assert.equal(permitsSubject(p, "private.data"), false);
  assert(Object.isFrozen(p) && Object.isFrozen(p.allow) && Object.isFrozen(p.deny));
  assert(p.allow.mode === "patterns" && Object.isFrozen(p.allow.patterns));
});
check("native round trips preserve decisions rather than empty-array spelling", () => {
  for (const p of [requestedSubjectPermission([]), requestedSubjectPermission(["orders.>"], ["orders.private"]), importNativeSubjectPermissions({}).publish]) {
    const back = importNativeSubjectPermissions({ pub: exportNativeSubjectPermission(p) }).publish;
    for (const name of ["orders", "orders.public", "orders.private", "other.data"])
      assert.equal(permitsSubject(back, name), permitsSubject(p, name));
  }
});
for (const value of [{ resp: {} }, { pub: { allow: ["orders.* workers"] } }, { sub: { allow: [{ subject: "orders.*", queue: "workers" }] } }, { pub: { allow: [">"], extra: true } }, { pub: undefined }, { pub: null }, { sub: { allow: null } }, []]) {
  check(`unsupported native input refuses: ${JSON.stringify(value)}`, () => assert.throws(() => importNativeSubjectPermissions(value)));
}
for (const value of ["orders..a", "orders.>.a", "orders.a*", "orders.a>", "", "orders." + String.fromCharCode(10) + "private", "orders." + String.fromCharCode(0) + "private"]) {
  check(`malformed subject pattern refuses: ${JSON.stringify(value)}`, () => assert.throws(() => requestedSubjectPermission([value])));
}
for (const value of [{ allow: { mode: "future" }, deny: [] }, { allow: { mode: "patterns", patterns: [] }, deny: [] }, { allow: { mode: "all", patterns: [] }, deny: [] }, { allow: { mode: "all" } }]) {
  check(`unsupported normalized value refuses: ${JSON.stringify(value)}`, () => assert.throws(() => readSubjectPermission(value)));
}
check("sparse lists, accessors and non-records cannot silently become unrestricted", () => {
  assert.throws(() => importNativeSubjectPermissions({ pub: { allow: new Array(1) } }));
  let read = false;
  assert.throws(() => importNativeSubjectPermissions({ get pub() { read = true; return {}; } }));
  assert.equal(read, false);
  assert.throws(() => importNativeSubjectPermissions(new Date()));
});
check("wildcard input cannot be evaluated as a concrete subject", () => {
  assert.throws(() => permitsSubject(requestedSubjectPermission([">"]), "orders.*"));
});
console.log(`issued-subject-permissions prototype: ${passed} passed`);
