---
"@cotal-ai/cli": patch
---

attach: own the keyboard whenever there is no session. Keystrokes typed at a terminal whose link
has died are read and dropped instead of buffered, so nothing an operator types at a frozen screen
is delivered to the agent by a reconnect they did not know had happened, Ctrl-C included. That now
covers every gap in the loop: the waits, the attempts, the hand-back of a session that faulted on a
link that is still up, and the first establishment, so a key struck before the very first attach
comes up does not arrive at the agent when it does. The detach key is read across all of them, and
a press that lands while a session is opening ends the attach rather than being swallowed by the
handoff to that session's own reader. With stdin a pipe the old behaviour is kept on purpose, in
every one of those windows rather than only the first: a script's input is buffered and delivered
when the session opens, including across a reconnect, so a feed piped into an attach does not lose
what was written while the link was down. `--no-reconnect` keeps the single-session behaviour
everywhere.

Also: a piped attach now gives the shell back when it detaches. `printf 'ls\n' | cotal attach --name
web --no-reconnect` printed `detached from web` and then held the process open, because nothing
released the command's own claim on stdin on the way out. That release is made where there is
something to release: a terminal and a pipe are sockets, while a stdin that is a file
(`cotal attach --name web < seed.txt`, or a parent that spawns attach with stdin ignored) is not,
and releasing it there raised `process.stdin.unref is not a function` on the way out.
