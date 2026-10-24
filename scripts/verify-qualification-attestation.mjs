#!/usr/bin/env node
import assert from "node:assert/strict";
import { join } from "node:path";
import { verifyBuildAttestation } from "./release-qualification.mjs";
import { isMainEntry } from "./main-entry.mjs";

// Exercise the real GitHub certificate and verifier during preparation, before the native
// matrix and before publish-go. These checks need no publication or registry credentials.
if (isMainEntry(import.meta.url)) {
  try {
    const directory = process.argv[2];
    assert(directory && /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? ""));
    const qualified = { source: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
    const options = { manifestFile: join(directory, "manifest.json"), bundleFile: join(directory, "qualification.sigstore.json"), qualified, deadline: Date.now() + 60_000 };
    verifyBuildAttestation(options);
    assert.throws(() => verifyBuildAttestation({ ...options, qualified: { ...qualified, source: "0".repeat(40) } }), /build attestation verification failed/);
    assert.throws(() => verifyBuildAttestation({ ...options, qualified: { ...qualified, runId: String(Number(qualified.runId) + 1) } }), /certificate belongs to another run or attempt/);
    assert.throws(() => verifyBuildAttestation({ ...options, qualified: { ...qualified, runAttempt: String(Number(qualified.runAttempt) + 1) } }), /certificate belongs to another run or attempt/);
    console.log("Verified live build certificate, source rejection and run/attempt rejection before qualification");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
