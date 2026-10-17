---
"cotal-ai": minor
"@cotal-ai/cli": minor
---

`cotal setup` sets up the runtimes your agents run in. On a terminal it asks which runtimes to set up after the application question: `pty` is built in and always set up, and each official runtime (`tmux`, `cmux`, `orca`, `herdr`) and each installed third-party runtime shows whether it is set up and whether its host tool is on PATH. Installed ones and ones whose tool was found start selected. A script names each runtime with `--runtime <name>`, repeatable; without it a script sets up no runtime beyond `pty`. An unknown name is `USAGE_INVALID` and an official runtime whose host tool is not on PATH is `DEPENDENCY_UNAVAILABLE`, both before anything is written.

Setup installs each chosen runtime as `cotal ext add` does, at the running cotal's version, then asks its provider whether it answers, as `cotal runtimes` reports. A chosen runtime whose host tool is missing is not installed, and one that does not install or answer leaves the rest saved and the result `partial` (exit 4). Setup never removes a runtime left out; `cotal ext remove` does. `result.runtimes` lists each runtime with its package, its host tool, whether it was chosen and whether setup found it set up, added it or left it out. With `--json` or `--plain` the install progress goes to stderr.

`cotal ext add` of a `@cotal-ai/*` package named without a version now installs the running cotal's version instead of the registry's newest, which could be a release the binary does not match. A version or tag you name is installed as given.
