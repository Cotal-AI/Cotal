# @cotal-ai/web

The Cotal browser dashboard. The package registers the `web` service preset and
peer-depends on core and workspace. See [watch a mesh](../../docs/watch-a-mesh.md)
for service setup and authentication.

## Frontend

The dashboard at `/` uses Astro, React, Tailwind CSS and official shadcn/ui
components. It includes the agent sidebar, activity feed, channel history, direct
messages, agent details and attention panel. The graph remains at `/graph`.

`ui/` owns the React presentation. `src/web/app.js` owns browser state and its
HTTP/SSE lifecycle. The transcript uses shadcn Message, Bubble and
MessageScroller components. Pause, history reading and jumping to the live edge
use the scroller API. Ordering notes and harness logos render in React; the
controller returns data rather than HTML for those views. Both pages load the shared
`presence.js` helper for condition and age wording, checked against core by
`pnpm smoke:web-presence-wording`. The monitor and graph share the existing snapshot, ordering,
message-part and sanitized Markdown helpers. UI libraries are development
dependencies bundled into `dist/ui`; the authenticated server serves that output.
The package build copies the controller, graph and vendored scripts to `dist/web`.

Use Node >= 22.23.4. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @cotal-ai/web... build
pnpm --filter @cotal-ai/web typecheck
```

After a production build, restart the web service and open its new launch link.
The server enumerates hashed assets at startup.

## Development

Start your configured Cotal web service, then point Astro at its HTTP origin:

```bash
COTAL_WEB_BACKEND=http://127.0.0.1:7799 pnpm --filter @cotal-ai/web dev
```

Open `http://127.0.0.1:4321/`. For a new browser session, open the service's fresh
single-use launch link with its host and port replaced by `127.0.0.1:4321`.
The dev proxy exchanges it with the backend and keeps the HttpOnly session cookie.
APIs, SSE, controller scripts and the graph use that backend; React and CSS edits
reload through Astro. After controller changes, rebuild the web package and
restart the backend. The proxy requires an explicit loopback HTTP origin and does
not bypass backend authentication or foreign-origin write checks. Astro without
this setting refuses startup instead of serving a dashboard with missing APIs.

## Browser checks

The browser smoke starts its own disposable broker and populated dashboard:

```bash
pnpm --filter @cotal-ai/web exec playwright install chromium
pnpm --filter @cotal-ai/web test:browser
COTAL_DASHBOARD_DEV=1 pnpm --filter @cotal-ai/web test:browser
```

Set `COTAL_BROWSER_PATH` to use an existing Chromium executable. The suite checks
the root UI, live/history merges, DMs, agent details, filters, safe Markdown,
resizing, deletion confirmation, failure recovery and mobile navigation.

The dashboard uses the neutral shadcn theme. Desktop navigation spans the full
viewport height, with the toolbar above the content beside it. Attention uses standard Item rows;
status icons and channel metadata sit beside the content they describe. The
attention panel opens as a sheet below 1280px to leave room for the conversation.
Ordering and stale-source alerts keep their full content in padded containers.
Failed channel deletion stays in the confirmation, pending deletion cannot be
dismissed, and closing the dialog restores focus to its trigger.
