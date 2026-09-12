---
---

The publish workflow now verifies every package in the lockstep fixed group before
cutting a GitHub Release, replacing the single-package `npm view cotal-ai@$version`
check that passed when one package published and twenty-one siblings did not (#1286).

The closure verifier now reads the response body on a 200 and asserts that it
identifies the requested package at the requested version. A 200 carrying a wrong
version, a wrong name, an error, or an unparseable body is treated as no evidence
rather than as presence (#1257).
