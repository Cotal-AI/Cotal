---
"cotal-ai": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`cotal space add` and `cotal space forget` register and forget spaces on the structured output contract.

- `cotal space add <name> --server <url>` registers a space that runs elsewhere, with the trust under `--root`. `cotal space add --file <bundle.json>` registers a user-auth space from a connection bundle, and `--from <https url>` fetches its discovery document on a terminal. Every check runs before anything is written, and each refusal carries its code: `CONFLICT` for a registered name or a broker that enforces another mode, `TARGET_UNAVAILABLE` for a broker that does not answer, `DEPENDENCY_UNAVAILABLE` for missing trust, `UNSUPPORTED` for an address credentials may not cross. On a terminal it shows what it will trust and asks; `--yes` skips that question. It never changes the selection. `--force` replaces only a registration added by hand.
- `cotal space forget <name>` removes a registration this machine keeps, and keeps the root's files. It refuses a space this machine is running and a space a catalog lists. Forgetting the selected space clears the selection.
- A registration check from `@cotal-ai/workspace` can carry its refusal code, and `preflightCode` is exported.
