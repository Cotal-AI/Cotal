# @cotal-ai/tui

The Cotal terminal app: one full-screen workspace where you watch, talk to and control agents. It is
built on OpenCode's terminal UI components (Solid on OpenTUI) and runs on Node.

This package is private. The app lists the spaces registered on this machine and opens one: the
space every command in the launch folder would pick, or the one you open with enter. It shows the
roster, the channels, the message feed, the agents waiting for an answer and the state of the
connection. You can write to a channel or an agent from it, and stop an agent through the manager
that runs it. Its observer is invisible to peers, and opening a space writes nothing to the registry
and starts no service.

## Running it

The app needs Node 26.4 or newer. OpenTUI loads its renderer through `node:ffi`, which Node gates
behind `--experimental-ffi`. The launcher refuses older Node, says how to install a newer one, and
adds the flag itself. The `cotal-ai` package itself still runs on Node 22.10 or newer.

```bash
pnpm --filter @cotal-ai/tui build
node implementations/tui/bin/cotal-tui.mjs
```

The `cotal` binary does not start this app yet.

Open and static-auth spaces open. On a static-auth space the app mints its observer's credential
in memory from the project's trust material, so the space must have been started on this machine. A
user-auth space is refused with `uses the "cotal" auth provider, which this build does not register`. Its credentials come from the auth provider in
`@cotal-ai/auth`, which this standalone launcher does not register, and this package cannot import
it without depending on another implementation. User-auth spaces will open once the bare `cotal`
command launches the app.

## Layout

Three columns. The left one lists the spaces, then the open space's channels, agents and endpoints,
with your name at the bottom. A chat session is listed while it is open, and yours only as that
name. The middle shows the open conversation, with the input box under it:
all traffic, one channel, or one agent with its question pinned when it waits. A space opens on
`#general`. The inspector on the right lists the agents waiting for an answer and the selected
agent's status, model, harness and uptime. When the conversation would get fewer than 40 columns, as
at 80x24, the inspector shrinks to a count such as `1 needs you` above the input box, and the agent
overview shows in the conversation while the tree has the keys. Each agent's name keeps one color in
the tree, the feed and the waiting list, and yours is gold.

The cursor starts in the input box. `tab` moves it to the tree, where the arrows or `j` and `k`
move, `enter` opens the row and returns to the box, and `esc` or `tab` returns without opening.
The letter keys work only in the tree: `w` opens the next waiting agent and `1`-`9` a specific one,
`D` stops an agent, `?` lists the keys and `q` quits. While a space opens, the box keeps the keys
before it is on screen, so a letter typed for it runs no tree key; `tab` moves them to the tree.
`ctrl+p` opens the commands and `ctrl+c` quits from anywhere.

While a space is open the app asks its managers every 10 seconds which agents they run. A managed
agent's overview adds its runtime (such as `pty`), whether its process is running, and the uptime the
manager counts, kept ticking between reads. An agent no manager runs says so. When a read fails the
overview shows the reason, and the app stops asking until the space reconnects. The reads write
nothing to the registry.

`D` on a selected agent that a manager reports running asks `Stop agent <name> via the manager?`.
`y` stops it gracefully, `f` force-kills it, and `n`, esc or enter cancel. The stop names the agent,
so `D` offers nothing for an agent no manager reports, even one that shares a managed agent's name,
or for a name two managed agents share. The line above the status bar shows `stopping <name>…`
or `force-killing <name>…` until the manager answers, then `stopped <name>`, `force-killed <name>` or
`stop: <error>`, cut to one line. The stop names the agent and not one run of it, as `cotal stop`
and the console do, so an agent restarted under the same name in the meantime is the one stopped.

The status bar shows `reconnecting` while the broker is away (the last model stays on screen) and
`not connected` when the space did not open, with the reason in the middle. While the space is
connected it shows only `? help` and `ctrl+p commands`.

## Talking

You watch a space without appearing in it. Your first message opens a chat session and sends in one
step, and you appear on the roster under your name: your saved `name` preference, else your OS
login. The name at the bottom of the left column is dim until then and gold after.

- The input box writes to the open conversation, and the line under it names where the message
  goes, such as `#general` or `answering coder-2`. A channel gets a post, an agent or endpoint gets
  a direct message, and a waiting agent gets your answer. `enter` sends and `ctrl+j` starts a new
  line. Every conversation keeps its own draft, in every space. `ctrl+p`, Send to a role, opens a
  role's conversation, whose messages go to whichever member takes them.
- To answer one message, quote it. On an empty box `↑` quotes the newest message, `↑` and `↓` move
  the quote to older and newer ones, and `↓` past the newest drops it. A click quotes a message
  too, and keeps what you typed. The quoted message is highlighted and shown above the box, and
  `enter` sends your reply: in a channel it stays there, and a direct message's reply goes back to
  its sender. `esc` drops the quote and keeps the text. A reply shows `↩` and the name it answers.
- `↑` and `↓` pass over what a reply cannot answer, and a click on it says why: your own direct
  messages, and direct messages between two others. In an agent's conversation only direct
  messages are quoted, so a reply there never posts to a channel. A message is yours when it comes
  from a session the app opened, or from any session under your name in any letter case.
- `@name` in a channel post mentions that peer, as `cotal send` does. A message that mentions you
  is marked `@you`.
- A line that starts with `/` is a command: `/reply` quotes the newest direct message you received
  above the text so the next `enter` answers it, and `/whoami`, `/connection`, `/reconnect`, `/status`, `/help` and
  `/quit` run as in `cotal chat`. `/quit` ends your session. `//` sends a line that starts with `/`.
  The other `cotal chat` commands are refused with a line that says where they run.
- `ctrl+p`, Change your name, saves the `name` preference for every chat session on this machine.
  An open session keeps its name until it ends. When another participant already holds your name,
  a warning says so.
- `ctrl+p`, End your chat session, does what `/quit` does.

On a static-auth space the space's manager admits the session, as it admits a `cotal chat`
session. The session may post only to the channel it opened on, or to none when it opened on an
agent, and it ends 15 minutes after it opened; the line under the box shows the time. Posting
elsewhere means `/quit`, then `enter` in that channel.

Your session ends when you switch spaces, quit, or type `/quit`. A message you sent with `enter`
just before still goes if it finishes sending within 5 seconds, the first one included while its
session opens. When that first message's session is still opening after 5 seconds, the message is
not sent: a switch warns you and keeps its draft, and a quit says so as the app exits. While a
switch waits, the conversation reads `Leaving <space>…`. A message still sending in one space
never holds up `enter` in another. After it ends, `enter` opens a new session under a new identity
and sends nothing; the next `enter` sends. Quitting with unsent drafts asks first. Quitting closes
the session and prints how it closed.

## Vendored OpenCode code

`vendor/opencode/` holds files copied from one pinned OpenCode commit under its MIT license
(`vendor/opencode/LICENSE`). Do not edit them by hand.

- `scripts/upstream.mjs` names the commit and the files Cotal imports. `scripts/vendor.mjs` copies
  those files and everything they import, applies `patches/*.patch` in order, and records the
  sha256 of each vendored file, each patch and each file under `types/` in
  `vendor/opencode/UPSTREAM.json`.
- `types/opencode-plugin.d.ts` is a trimmed copy of the OpenCode plugin types that the vendored
  keymap imports. The typecheck reads it in place of OpenCode's client types.
- To change vendored code, add a patch and rerun `pnpm --filter @cotal-ai/tui vendor`. Rerun it
  after editing a patch or the type file too.
- `build`, `typecheck` and `test` run `scripts/check-vendor.mjs`. It fails when a file under
  `vendor/opencode/`, `patches/` or `types/` differs from its recorded hash, is not recorded, or is
  recorded but missing.

`scripts/build.mjs` compiles `src/` and `vendor/` to `dist/` with Babel, because Solid on OpenTUI
needs babel-preset-solid's universal output. `tsc` only typechecks.

## Checks

- `pnpm --filter @cotal-ai/tui smoke` drives the launcher in tmux at 209x52, 97x49 and 80x24
  against an isolated HOME and asserts the frame text. `smoke/shell.smoke.ts` covers the catalog
  and a space that cannot be opened, and that letters typed while a space opens run no tree key.
  `smoke/live.smoke.ts` starts its own broker and peers and covers the live screens, the letter keys
  typing into the box until `tab`, and a broker restart.
  `smoke/control.smoke.ts` runs a real manager with two seats and covers the overview, the confirm
  and both kinds of stop, a stop refused for an unmanaged agent and for a name two managers hold, a
  space with no manager, and a broker that turns auth on while the app reads its managers, after
  which the space is still registered.
  `smoke/composer.smoke.ts` writes from the input box at 209x52 and 80x24 on an open space and on a
  static-auth space that a real `cotal up --detach` stack serves. It reads each send off the broker:
  a post with its mention, a direct message to one of two agents that share a name, an answer to a
  waiting agent, `/reply` with the message it answers, and a message to an offline agent. It reads
  each refusal off the screen: no recipient, unknown commands, the post grant and an unreachable
  broker. It also covers watching unseen while you type, the first `enter` opening
  the session and sending, your name turning gold, the shared-name warning, `/quit` and the
  two-step reopen, a space switch that closes the session and keeps the draft, a space switch while
  the first message opens its session, `ctrl+c` with a draft, and Change your name.
  Its quotes reply with `replyTo` from `↑` and a click. A burst of one direct message to several
  agents is quoted only when its first copy came to you, and its reply names your copy.
  After Change your name and `/quit`, `↑` passes over your own direct messages.
  `↑` and a click also pass over a namesake's message, an agent's channel posts in its
  conversation, and a direct message between two agents in all traffic.
  With the static space's manager held, a switch and a quit each say the first message was not
  sent, and the space switched to sends at once.
  They need Node 26.4, tmux and nats-server, and the control and composer smokes need the manager
  built, so they are not in `smoke:ci`.
- `pnpm --filter @cotal-ai/tui measure:startup` times launch to the first frame and to the space
  list under tmux.
