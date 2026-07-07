Add an activity pulse to cotal console: a live sparkline (unicode block bars ▁▂▃▄▅▆▇█) of message volume over the last ~60s, shown next to the msg/s readout in the StatusBar. Keep it compact: a fixed width of about 20 columns (just the most recent buckets), do NOT scale it to the terminal width. Extend the existing console, do not rebuild it, and do not open a new NATS connection.

Done when the sparkline renders from real data and pnpm --filter @cotal-ai/cli typecheck is green.
