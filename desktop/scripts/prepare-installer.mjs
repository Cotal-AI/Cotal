import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = new URL('../src-tauri/installers/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
if (pkg.devDependencies['@tauri-apps/cli'] !== '2.12.4') throw new Error('Review the Windows service guard against the new Tauri NSIS template before changing the CLI version.');
const source = readFileSync(new URL('tauri-2.12.4.nsi', base), 'utf8');
if (createHash('sha256').update(source).digest('hex') !== 'd00089d3b1a2c4a30d7b6e098079100cb8f25e980f84d4515aca4597b95e967d') throw new Error('The pinned upstream NSIS template changed. Review the service guard before building.');
const anchor = '  ; Read the install choice header through $R5 so a custom language file that only';
if (source.split(anchor).length !== 2) throw new Error('The NSIS upgrade routing anchor is not singular.');
const guard = '  ; A newer installer owns service preparation before replacing any files.\n  ; Never run the installed uninstaller before that guard.\n  ${If} $WixMode <> 1\n  ${AndIf} $R0 = 1\n    Abort\n  ${EndIf}\n\n';
writeFileSync(new URL('installer.nsi', base), source.replace(anchor, guard + anchor));
console.log(`Prepared guarded NSIS template: ${fileURLToPath(new URL('installer.nsi', base))}`);
