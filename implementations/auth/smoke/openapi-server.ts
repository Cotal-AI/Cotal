// Runs the stock auth command in a private fixture root. All Cotal environment
// values are removed by the parent before this process starts.
import { runAuthService } from '../src/service.js';
const [space, server, port, endpoints] = process.argv.slice(2);
if (!space || !server || !port) throw new Error('Expected space, broker and public port');
await runAuthService({ values: {
  space, server, 'exchange-public-port': port,
  'exchange-public-url': 'https://auth.smoke.invalid',
  ...(endpoints === 'enabled' ? { 'service-endpoints': true } : {}),
}, positionals: [], raw: [] });
