# @cotal-ai/tui

The Cotal terminal app: one full-screen workspace where you watch, talk to and control agents. It is
built on OpenCode's terminal UI components (Solid on OpenTUI) and runs on Node.

This package is private. The app lists the spaces registered on this machine and opens one: the
space every command in the launch folder would pick, or the one you open with enter. It shows the
roster, the channels, the message feed, the agents waiting for an answer and the state of the
connection. You can write to a channel or an agent from it, spawn an agent from a persona through
the space's manager, and stop an agent through the manager that runs it. Its observer is invisible
to peers, and opening a space writes nothing to the registry and starts no service.

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
`#general`. The inspector on the right lists the agents waiting for an answer, then the direct
messages to you that you have not read, one card per sender, then the replies to your messages and
the messages that mention you, newest first, and the selected agent's status, model, harness and
uptime. The list scrolls when it is longer than the screen. An unread card shows the sender, how many
messages are new when there is more than one, and the start of the newest. It opens the sender's
conversation, and their messages are read once it is open, also the ones that arrive while it stays
open. A direct message that replies to you or mentions you is a reply or mention card instead, so no
message is listed twice. Which messages you read is saved (see
[Remembered sessions](#remembered-sessions)), so an unread card is still listed after a restart and a
read one stays gone. When the app could not read your earlier direct messages, the unread group says
why instead of listing none. A reply or mention
card opens its channel, or its sender's conversation for a direct message, scrolls to the message and
quotes it in the input box, so the next `enter` sends a reply to it. When the reply rules refuse the
message, the box says why and quotes nothing. A card stays listed until you reply to it or dismiss
it, also after its message has left the recent messages the app holds. It goes once a reply you
sent with its message quoted shows in the conversation, and a message you send without the quote
leaves it listed. A card whose message has left its conversation still opens it and quotes the
message, and the next `enter` sends the reply. Each space keeps its cards while the app runs, also
while another space is open. After a restart the list starts again from the history the app
loads, the newest 50 messages of each channel and 300 in all. A channel card comes back when its
message is in that history, and stays gone when your reply is there too. A direct message's card
comes back from your earlier sessions' direct messages (see [Remembered sessions](#remembered-sessions)),
and stays gone when your answer is among them. A card you opened is drawn
dimmer than one you have not, and a reply or mention that arrives in the conversation you have open
is listed already dimmed.
When the conversation
would get fewer than 40 columns, as at 80x24, the inspector shrinks to a count such as
`1 needs you · 3 unread · 2 replies · 1 mention` above the input box, counting the cards you opened
too, with `DMs missing` when your earlier direct messages could not be read, and the agent overview shows in the
conversation while the tree has the keys. Each agent's name keeps one color in
the tree, the feed and the waiting list, and yours is gold.

The cursor starts in the input box. `tab` moves it to the tree, then to the inspector, then back to
the box. At 80x24, with no inspector on screen, `tab` in the tree returns to the box. In the tree and
the inspector the arrows or `j` and `k` move the highlight, `enter` opens the item and returns to the
box, and `esc` returns without opening. `enter` on a card quotes its message, and on a waiting agent
opens its conversation with no quote, as it does on an unread card. A click on an item does what
`enter` does. `x` in the inspector dismisses the highlighted card without replying, and marks an
unread card's messages read without opening them. A waiting agent cannot be dismissed. Opened and
dismissed reply and mention cards are remembered until the app quits. The highlight stays on its item as new ones
arrive, and when a card goes, the item that takes its place is highlighted. The letter keys work only
in the tree and the inspector: `w` opens the next item the inspector lists, waiting agents first, and
`1`-`9` a specific one, quoting a card's message as `enter` does while the keys stay where they are. `S` spawns an agent, `D` stops one, `?` lists the keys and `q` quits. While a space opens, the box keeps the keys
before it is on screen, so a letter typed for it runs no tree key; `tab` moves them to the tree.
`ctrl+p` opens the commands and `ctrl+c` quits from anywhere.

While a space is open the app asks its managers every 10 seconds which agents they run. A managed
agent's overview adds its runtime (such as `pty`), whether its process is running, and the uptime the
manager counts, kept ticking between reads. An agent no manager runs says so. When a read fails the
overview shows the reason, and the app stops asking until the space reconnects. The reads write
nothing to the registry.

`D` on a selected agent that a manager reports running asks `Stop agent <name> via the manager?`.
`y` stops it gracefully, `f` force-kills it, and `n`, esc or enter cancel. The stop acts on the run
the overview showed when you pressed `D`. If a new run has replaced it under the same name since,
nothing is stopped and the app reads its managers again. The manager finds the agent by name, so
`D` offers nothing for an agent no manager reports, even one that shares a managed agent's name,
or for a name two managed agents share. The line above the status bar shows `stopping <name>…`
or `force-killing <name>…` until the manager answers, then `stopped <name>`, `force-killed <name>` or
`stop: <error>`, cut to one line.

`S` in the tree, or `ctrl+p` and Spawn agent, opens the persona list: the personas in the space's
catalog, the ones `cotal spawn <persona>` completes from, with each one's description and the
application it runs in. The personas spawned from this app since it started come first, under
Recent. The persona a launch uses when none is named is marked `●` and highlighted. Typing searches
the list.

`enter` opens the settings for the persona picked, titled `Spawn <persona>` over its description.
Each row shows its value on the right, and a value you changed turns gold:

- Prompt: an optional first message the agent gets once it joins, typed in the row. It wraps and
  grows to four lines, and `alt+enter`, `shift+enter` or `ctrl+j` types a newline where the terminal
  sends it.
- Application: the persona's own, else your default from `COTAL_DEFAULT_AGENT` or your saved
  `harness` preference. `←` `→` pick another one that the space's manager can run.
- Model: the persona's, else the application's default. `←` `→` pick one of the models the manager
  lists for the application.
- Effort: the model's variant, such as Codex's reasoning effort. The persona's `variant:`, else the
  application's default. `←` `→` pick one of the efforts the manager lists for the model. The row is
  disabled, with the reason, until a model that offers efforts is picked: `choose a model first`,
  `not offered for <model>`, or `not offered by <application>`. Changing the application or the
  model puts it back to its default.
- Name: the persona's name, edited in the row. Clearing it uses the persona's name. A name the mesh
  cannot carry is refused as you type it, under the row.

The rows open on Prompt. `↑` `↓` move between them and skip a disabled Effort, and in a prompt of
several lines they move its cursor first. `enter` spawns from any row, and `esc` returns to the
persona list. When a value is refused, `enter` highlights its row and launches nothing.

The applications are the ones the space's manager reports available. An application with
no activity feed (event plane), such as Hermes, shows `no activity feed` and launches without one.
On a space whose policy requires an activity feed it is refused with `this space requires an
activity feed`. When the manager cannot be asked, `S` says why and opens nothing.

The line above the status bar shows `spawning <persona>…`, then
`the manager started <name>; waiting for it on the roster…` until the agent is on the roster, then
`<name> joined`, followed by what the manager said when it launched the agent without its activity
feed. The new agent's conversation opens when you are still on the conversation you
spawned from. A refusal shows `spawn: <error>`, cut to one line, with the reason when the agent
exited inside the manager's join window. An agent whose process still runs when that window ends
shows `<name> is running but has not joined yet; following it`, with the time since the launch, and
the app asks the manager for its seats every two seconds until the agent joins or the manager no
longer lists it. Then it shows `<name> joined`, or
``<name> exited before it joined; `cotal manager logs` shows why``, since the manager reports an
exit after its join window only in its log. A failed spawn stays on the line until the next one
starts, and several spawns can run at once, one line each.

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
  from a session the app opened, in this run or an earlier one it remembers, or from any session
  under your name in any letter case. A direct message is to you only when it went to one of those
  sessions the app opened.
- `@name` in a channel post mentions that peer, as `cotal send` does. A message that mentions you
  is marked `@you`.
- A line that starts with `/` is a command: `/reply` quotes the newest direct message you received
  above the text so the next `enter` answers it, and `/whoami`, `/connection`, `/reconnect`, `/status`, `/help` and
  `/quit` run as in `cotal chat`. `/quit` ends your session. `//` sends a line that starts with `/`.
  The other `cotal chat` commands are refused with a line that says where they run.
- `ctrl+p`, Change your name, saves the `name` preference for every chat session on this machine.
  An open session keeps its name until it ends. When another participant already holds your name,
  a warning says so. The name at the bottom of the tree is the one your next session joins under.
  The app reads it when the space opens, when a session ends and when you change it here, so a
  name saved with `cotal config set name` shows from the next of those.
- `ctrl+p`, End your chat session, does what `/quit` does.

On a static-auth space the space's manager admits the session, as it admits a `cotal chat`
session. The session may post only to the channel it opened on, or to none when it opened on an
agent, and it ends 15 minutes after it opened; the line under the box shows the time. Posting
elsewhere means `/quit`, then `enter` in that channel.

Your session ends when you switch spaces, quit, or type `/quit`. A message you sent with `enter`
just before still goes if it finishes sending within 5 seconds, the first one included while its
session opens. When that first message's session is still opening after 5 seconds, the message is
not sent: a switch warns you and keeps its draft, and a quit says so as the app exits. A later
message that takes longer than 5 seconds is not waited for, and the switch or quit closes the
session without a warning. While a switch waits, the conversation reads `Leaving <space>…`. A
message still sending in one space never holds up `enter` in another. After it ends, `enter` opens
a new session under a new identity and sends nothing; the next `enter` sends. Quitting with unsent
drafts asks first. Quitting closes the session and prints how it closed.

### Remembered sessions

The app remembers each session it opens, so a later run counts that session as yours. A space keeps
its 20 newest, each in a private file under `~/.cotal/chat-sessions/` with the session's principal,
name, broker and opening time, and no credential. When a space opens, the app reads the newest 200
direct messages to and from those sessions with the credential its observer already holds, and
shows them in their conversations with their cards, so `↑` quotes them. Your answer goes from the
new session, under the same name. On a static-auth space, a direct message an agent sends to an
earlier session while the app runs shows at the next start; on an open space it shows when it
arrives. When the broker refuses that read, or a remembered session cannot be read, a warning says
why and the agent's conversation keeps saying it. The direct messages you read are saved by id in the
same folder, in a private `read.json` that keeps the newest 1000, so they stay read after a restart.
When it cannot be read, a warning says so and every direct message to you shows as unread; when it
cannot be written, a warning says the messages you just read will show as unread after a restart.
`cotal space forget` removes a space's remembered sessions and its read messages. Sessions opened
with `cotal chat` are not remembered.

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
  and both kinds of stop, a stop refused for an unmanaged agent, for a run replaced under the same
  name after `D`, and for a name two managers hold, a space with no manager, and a broker that turns
  auth on while the app reads its managers, after which the space is still registered.
  `smoke/spawn.smoke.ts` first checks what a launch sends for the activity feed on each kind of
  application and space, and the form's defaults. It then runs a real manager at 209x52 and 80x24
  and spawns from `S` and the palette, reading each agent off the broker's roster and each launch
  where the manager hands it to the connector. It checks the persona list and Recent, the form's
  defaults with no Events row and no key hints, enter twice with every default, a cycled model and
  effort, a prompt of two lines and an edited name sent from the model row, the effort a launch
  sends only when it changed and why the row is disabled, a refused name that stops enter, an
  application with no activity feed, one the manager does not have, `esc` back to the list and `?`. A second
  manager serves a space that requires the activity feed, where such an application is refused and
  another launches. It also covers a space with no manager and a seat that outlives its join window
  and then exits, which the notice line follows until it says the seat exited.
  `smoke/composer.smoke.ts` writes from the input box at 209x52 and 80x24 on an open space and on a
  static-auth space that a real `cotal up --detach` stack serves. It reads each send off the broker:
  a post with its mention, a direct message to one of two agents that share a name, an answer to a
  waiting agent, `/reply` with the message it answers, and a message to an offline agent. It reads
  each refusal off the screen: no recipient, unknown commands, the post grant and an unreachable
  broker. It also covers watching unseen while you type, the first `enter` opening
  the session and sending, your name turning gold, the shared-name warning, `/quit` and the
  two-step reopen, a space switch that closes the session and keeps the draft, a space switch while
  the first message opens its session, `ctrl+c` with a draft, Change your name, and a name saved
  with `cotal config set name` while the app runs.
  Its quotes reply with `replyTo` from `↑` and a click. A burst of one direct message to several
  agents is quoted only when its first copy came to you, and its reply names your copy.
  After Change your name and `/quit`, `↑` passes over your own direct messages.
  `↑` and a click also pass over a namesake's message, an agent's channel posts in its
  conversation, and in all traffic a direct message between two agents or to a namesake.
  With the static space's manager held, a switch and a quit each say the first message was not
  sent, and the space switched to sends at once.
  `smoke/cards.smoke.ts` posts from the input box at 209x52, 97x49 and 80x24 on an open space, then
  has peers reply in a channel, mention you in another and reply by direct message. It reads the
  inspector's order and the one-line count at 80x24 off the screen. Where the inspector shows, it
  moves the keys there with `tab`, reads the highlight off the screen's colors as the arrows and `j`
  `k` move it, and opens the waiting agent and a card with `enter`. It checks that the card's message
  is quoted under the box, that the opened card stays listed and is drawn dimmer than an unseen one,
  that the next `enter` sends a reply a peer receives with that message's id, and that the card then
  goes and the highlight stays in its slot. It checks that `x` dismisses a card and sends nothing,
  that `x` leaves a waiting agent, and that sixteen more cards are all reached by the arrows as the
  list scrolls. At 80x24 `tab` skips to the box. It opens cards with `w`, a click and a number too,
  and checks that each quotes and stays listed after you leave it, that a mention of someone else or a
  reply to a peer makes none, that a post without the quote leaves the card listed, and that a mention
  in the open conversation makes a card already dimmed. It then quits, starts the app again on the
  same space, and checks that the replied card stays gone while the dismissed ones are back. At
  209x52 an agent then posts 250 messages in another channel, and it checks that two new cards stay
  listed, that one answered goes and stays gone after 250 more posts, and that the other, whose
  message has left the loaded rows, is still listed after a switch to another space and back, then
  quotes it and sends a reply a peer receives with its id. It then checks that a reply to a post
  you sent before 250 more posts in another channel still makes a card.
  `smoke/continuity.smoke.ts` writes to an agent on an open space and on a static-auth space that a
  real `cotal up --detach` stack serves, then quits and starts the app again. It checks that the
  session's record is one private file with no credential, that the reply card, the conversation and
  the `↑` quote come back, that the answer reaches the agent with the reply's id from a new session
  under the same name, and that the answered card stays gone at the next start. It then has the agent
  write to the first session, which shows as it arrives on the open space and at the next start on
  the static one. On the open space it runs two copies of the app at once and reads both sessions'
  records back, then restarts the broker with a default user that may not read direct messages and
  checks the agent's conversation says so, and that the unread group says so too. Before that, on the
  open space, the agent writes to the human unprompted: the message is listed under unread direct
  messages above the replies and still after a restart, `w` opens it and the card goes, `read.json`
  records its id in a 0600 file, and it stays gone at the next start.
  They need Node 26.4, tmux and nats-server, and the control, spawn, composer and continuity smokes
  need the manager built, so they are not in `smoke:ci`.
- `pnpm --filter @cotal-ai/tui measure:startup` times launch to the first frame and to the space
  list under tmux.
