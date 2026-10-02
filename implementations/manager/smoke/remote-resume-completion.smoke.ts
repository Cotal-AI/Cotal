// Exercise the real already-answered workflow through completion before its held-slot probe.
process.env.EF_REFUSE_SCOPE = "run";
process.env.EF_COMPLETE_BEFORE_PROBE = "1";
await import("./remote-ef-continuity.smoke.js");
export {};
