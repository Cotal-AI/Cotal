---
"@cotal-ai/workspace": minor
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

Read commands no longer install or refresh the built-in connectors and the web dashboard before they run. A command or subcommand declares that it only reads with `reads` (a new optional field on `Command` and `Subcommand` in `@cotal-ai/core`), and the dispatcher skips the seed for it: `status`, `ps`, `who`, `whoami`, `models`, `runtimes`, `history`, `docs`, `endpoints`, `describe`, bare `space` and `space show`, bare `config` and `config get`, and bare `ext`, `ext list` and `ext root`. Installed extension commands keep the declaration through caching and lazy dispatch, including bare reads. Every other command still seeds first, so the first such command after an upgrade refreshes what is installed. The CLI never imports a built-in installed at another version than its own; it names the package and `cotal ext seed` instead. On a fresh machine `status` points at `cotal setup` for the connectors.

Breaking: a read run right after an install, such as `cotal ext list`, no longer installs the built-ins. Run `cotal ext seed`, `cotal setup` or any command that is not a read. See the upgrade notes.
