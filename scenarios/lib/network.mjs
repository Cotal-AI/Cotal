// "Offline" means the services Cotal uses cannot be reached: their names point at addresses that
// never answer (TEST-NET-1 and the IPv6 discard prefix), so connections hang the way they do on a
// dead network. The test machine itself keeps its connection to the CI service.
const HOSTS = [
  'cotal.ai', 'www.cotal.ai', 'get.cotal.ai', 'docs.cotal.ai', 'broker.cotal.ai', 'cloud.cotal.ai',
  'cotal.cloud', 'www.cotal.cloud', 'github.com', 'api.github.com', 'objects.githubusercontent.com',
  'release-assets.githubusercontent.com', 'raw.githubusercontent.com', 'registry.npmjs.org', 'www.npmjs.com',
];
const BEGIN = '# cotal-scenario offline begin';
const END = '# cotal-scenario offline end';

function without(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error('hosts file has an unterminated cotal-scenario block');
  return text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, '');
}

export async function offline(os) {
  const lines = HOSTS.flatMap((host) => [`192.0.2.1 ${host}`, `100::1 ${host}`]);
  await os.setHosts((text) => `${without(text).replace(/\s*$/, '\n')}${BEGIN}\n${lines.join('\n')}\n${END}\n`);
  return { unreachable: HOSTS.length };
}

export async function online(os) {
  await os.setHosts(without);
}
