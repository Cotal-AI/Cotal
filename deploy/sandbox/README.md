# Isolated shell seats

Use OS isolation for an untrusted agent with shell access. The ordinary `pty`, `tmux`, `cmux`,
`orca` and `herdr` launches are trusted same-user seats. Their environment filtering and private
application homes do not keep the operator's files out of reach.

`launch.mjs` runs one command inside a Linux Bubblewrap sandbox. It does not start a manager,
change a seat's mesh identity, or make the existing Docker team composition safe for untrusted
agents. Keep the manager, account signer and operator login outside the sandbox.

## Prepare the filesystem

Install Bubblewrap at `/usr/bin/bwrap` on the launch host. User, PID, IPC, UTS and cgroup namespaces
must work, including Bubblewrap's `--disable-userns`. Unsupported environments fail without running
the command outside the sandbox.

Provide a separately built root filesystem containing Node, the installed Cotal release, the
chosen harness and its connector. Use a clean image, not a copy of the operator's filesystem.
Review its contents for secrets and sockets. The root filesystem must have real directories at
`/home`, `/run`, `/tmp`, `/work`, `/proc` and `/dev`. These are replaced with private mounts.
Do not modify the image while a seat is running. The remaining image is read-only.

Put a review checkout or task files in that image before launch. Do not include `.cotal` signing
material, a Git credential helper, an operator login, a container socket or private application
state. There is deliberately no arbitrary host-directory mount option. `/work` is a fresh writable
directory for each invocation. It and the seat's private home disappear when the sandbox exits.
Copy an image's task files into `/work` if the task needs to edit them. Collect results through
the seat's scoped mesh tools or stdout.

## Start one seat

A foreground enrollment is the existing path for a seat that holds no human login. The operator
supplies one enrollment file and a persona. Each input is copied into `/run/cotal/<name>` as a
mode-`0600` file. Its parent directory is not mounted, and changing or deleting the copy does not
change the original. Only regular files are accepted. Never supply an account signer or operator
credential as an input.

For an image whose `cotal` and harness executables are on its standard `PATH`:

```bash
node deploy/sandbox/launch.mjs --rootfs ./seat-rootfs --network host \
  --input enrollment=./seat-enrollment --input persona.md=./reviewer.md \
  --env ANTHROPIC_API_KEY -- \
  cotal spawn --foreground --file /run/cotal/persona.md --space main \
    --enrollment-file /run/cotal/enrollment
```

The operator obtains the enrollment through the mesh's normal enrollment service. It grants only
that seat's channels and capabilities. The command above uses the existing
[foreground enrollment](../../docs/cli-agents.mdx#foreground-enrollment) contract. A managed runtime
can use the existing managed handoff instead, with only that lifecycle's handoff file.

No host environment is inherited by default. `--env NAME` deliberately shares that named variable,
for example a model provider key. Home, config, runtime, temporary and Cotal state paths are fixed
inside the sandbox and cannot be overridden by this option. Never forward a human bearer, a
credential-bearing proxy URL or a privileged local-service token. All deliberately supplied
credentials remain available to the agent and its tools.

The launcher preserves command arguments and the command's exit code. It forwards interrupt and
termination to Bubblewrap. Bubblewrap owns the PID namespace and ends its processes when the
sandbox exits or its launcher dies. No process or writable state is reused between launches.

## Network scope

The default `--network none` creates a private network namespace with no broker or model API
access. `--network host` explicitly shares the host network so a seat can reach its broker and
provider. This does not impose an egress policy or protect unauthenticated loopback services and
abstract Unix sockets. Use a separate host or an externally confined network when those services
are part of the threat model. This launcher is not a VM or a defense against kernel exploits.

The filesystem boundary prevents the reproduced accidental operator CLI path: a bare `cotal send`
inside the sandbox cannot discover the host's registry, login or signer. An explicitly supplied
scoped seat credential still authenticates as that seat, never as the operator. Merely setting
`COTAL_HOME` on an ordinary same-user launch does not provide this boundary.

## Check it

After installing and building the workspace, on Linux with Bubblewrap and `nats-server` available:

```bash
pnpm smoke:isolated-seat:live
```

The smoke uses an owned broker, disposable operator authority and the shipped CLI. It checks
operator attribution outside the sandbox, refused bare sends inside it, a scoped seat send,
out-of-grant refusal, path and environment isolation, and launcher input failures. It launches no
model, native service or manager.
