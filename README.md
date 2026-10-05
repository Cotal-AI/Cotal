# Booth demo

A self-contained web app for a booth screen: four interactive, thirty-second pictures of what
Cotal does. Nothing here talks to a real mesh; every demo is scripted so it never depends on
the venue network, an API key, or a model having a good day.

## Run it

Open `index.html` in Chrome or Edge. No server, no install, no internet: fonts, logos and the
pixel faces are all local files. Press `F` for fullscreen.

Before the event: turn off screen sleep and notifications on the booth machine, open the page,
press `F`, and leave it. The screen plays the demos on its own when nobody touches it, and any
touch or key hands control to the visitor.

## On a phone

The idle screen and the demo picker show a QR code for https://booth.apps.cotal.ai/?qr=1, so
visitors can run the demos on their own phone. The page stacks every demo vertically on a
portrait phone. A phone, or any visit through the QR link, skips the kiosk idle loop: nothing
plays by itself, and a back arrow returns to the demo picker. The QR matrix is inlined in
`index.html`; regenerate it with any QR encoder if the address changes.

## The four demos

| # | Title | What the visitor presses | What it shows |
| --- | --- | --- | --- |
| 1 | A team ships a feature | one button | Five agents from four vendors coordinate as peers: multicast, unicast, anycast, presence, and a late joiner replaying history. Pixel faces lip-sync what each agent says. |
| 2 | Three ways to send | Multicast / Unicast / Anycast, any order | One addressing scheme. Unicast to a busy peer queues in his durable inbox and drains in order; anycast skips the busy reviewer and the next free one claims the work. |
| 3 | Any topology | Peers / Supervisor / Tree / Pipeline / Hybrid / +40 agents | The same nine agents re-wire live into each shape, including a nested tree of sub-leads. Forty more agents can join any shape, with live status and traffic. Picking another shape returns to nine. |
| 4 | A pipeline across machines | Run · Unplug the laptop · Resume on the server | A Cotal Lang program works a GitHub backlog across three machines: triage labels each issue, a fixer opens a PR per confirmed issue, and two reviewers from different model families approve or block it. The laptop running the workflow is unplugged mid-review. The run resumes on the server from its step journal, and only the lost reviewer runs again. |

The caption bar is the talk track: read it out loud, or let visitors read it themselves.

## Keys

`1`–`4` pick a demo (or a toolbar button inside one) · `Space` press the highlighted button ·
`R` replay · `→` `←` next and previous · `Esc` back · `F` fullscreen · `M` sound · `?` help.

## Files

`index.html` the page · `booth.js` the engine (constellation canvas, panels, run control, idle
loop) · `demos.js` the four scripts · `face.js` the pixel-face renderer · `personas.js` face data
generated from `examples/04-frontier-faces/personas.mjs` · `fonts/` self-hosted Work Sans and
JetBrains Mono · `assets/` the mark and the agent logos.
