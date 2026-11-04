// Runs the production HTTP handler against a private smoke broker, without local
// account discovery or credentials from the operator's workstation.
import { web } from '../src/web.js';

const [server, space, port] = process.argv.slice(2);
if (!server || !space || !port) throw new Error('Expected broker, space and dashboard port');
let launchUrl: string | undefined;
await web({ values: { host: '127.0.0.1', port, 'no-open': true }, positionals: [], raw: [] }, {
  connection: { server, space, tls: false },
  onSession: (session) => { launchUrl = session.launchUrl; },
  onReady: () => { console.log(JSON.stringify({ ready: true, launchUrl })); },
  onClosed: () => {},
});
