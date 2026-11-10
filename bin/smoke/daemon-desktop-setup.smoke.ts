/** Real stdio app setup, account-shell PATH refresh, hosted launches and daemon restart. */
process.argv.push("--hosting-only", "--setup-path-repro", "--desktop-setup-only");
await import("./daemon-service-connect.smoke.js");
export {};
