// Keep pooled PTY refusal and the noncustodial accepted-goal path in the regular gate.
process.env.EF_POOLED = "1";
await import("./remote-ef-accepted-goal.smoke.js");
export {};
