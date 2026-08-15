// NON-EQUIVALENCE WITNESS for the G1 mutant: what an operator actually SEES for a lease whose
// writer stamped it 5s in the FUTURE. Run under the mutant and again on the restored tree; the two
// lines must differ, or the mutant changed nothing observable and proves nothing.
import { assessDeliveryHealth, renderHealth } from "../../packages/core/src/health.js";

const now = 1_000_000;
const h = await assessDeliveryHealth(0, 30_000, 2_000, {
  readLease: async () => ({ holder: "daemon-A", since: now + 5_000, ready: true }),
  probe: async () => { /* the daemon answered */ },
  now: () => now,
});
console.log(`serving=${h.serving}`);
console.log(renderHealth(h));
