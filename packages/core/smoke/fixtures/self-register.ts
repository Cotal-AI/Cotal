// A minimal self-registering extension module, imported by registry-staging.smoke.ts to prove that a
// dynamic import()'s top-level registration lands in the caller's active stage (AsyncLocalStorage
// propagates through module evaluation), not the live registry.
import { registry } from "../../src/registry.js";

registry.register({ kind: "connector", name: "fixture-import" });
