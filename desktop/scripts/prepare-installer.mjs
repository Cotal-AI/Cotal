import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = new URL('../src-tauri/installers/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
if (pkg.devDependencies['@tauri-apps/cli'] !== '2.12.4') throw new Error('Review the Windows service guard against the new Tauri NSIS template before changing the CLI version.');
const source = readFileSync(new URL('tauri-2.12.4.nsi', base), 'utf8');
if (createHash('sha256').update(source).digest('hex') !== 'd00089d3b1a2c4a30d7b6e098079100cb8f25e980f84d4515aca4597b95e967d') throw new Error('The pinned upstream NSIS template changed. Review the service guard before building.');
const welcomeAnchor = '; 1. Welcome Page\n!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_WELCOME';
if (source.split(welcomeAnchor).length !== 2) throw new Error('The NSIS welcome page anchor is not singular.');
const welcomeShow = '; 1. Welcome Page\n!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow\n!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_WELCOME\n\nFunction WelcomePlace\n  GetFunctionAddress $0 WelcomePlace\n  nsDialogs::KillTimer $0\n  ${If} $PassiveMode <> 1\n  ${AndIfNot} ${Silent}\n    System::Call "user32::SetWindowPos(p $HWNDPARENT, p -1, i 0, i 0, i 0, i 0, i 0x13)"\n    System::Call "user32::SetWindowPos(p $HWNDPARENT, p -2, i 0, i 0, i 0, i 0, i 0x13)"\n  ${EndIf}\nFunctionEnd\n\nFunction WelcomeShow\n  GetFunctionAddress $0 WelcomePlace\n  nsDialogs::CreateTimer $0 1\nFunctionEnd';

const anchor = '  ; Read the install choice header through $R5 so a custom language file that only';
if (source.split(anchor).length !== 2) throw new Error('The NSIS upgrade routing anchor is not singular.');
const guard = '  ; A newer installer owns service preparation before replacing any files.\n  ; Never run the installed uninstaller before that guard.\n  ${If} $WixMode <> 1\n  ${AndIf} $R0 = 1\n    Abort\n  ${EndIf}\n\n';
const confirmAnchor = '!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow\nFunction un.ConfirmShow ; Add add a `Delete app data` check box';
const copyAnchor = '  ; Copy main executable\n  File "${MAINBINARYSRCPATH}"';
if (source.split(copyAnchor).length !== 2) throw new Error('The NSIS file-copy anchor is not singular.');
if (source.split(confirmAnchor).length !== 2) throw new Error('The NSIS uninstall confirm anchor is not singular.');
const hooksAnchor = '{{#if installer_hooks}}\n!include "{{installer_hooks}}"\n{{/if}}';
const pluginDefine = '!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"\n';
const pluginDir = '# additional plugins\n!addplugindir "${ADDITIONALPLUGINSPATH}"\n\n';
if (source.split(hooksAnchor).length !== 2 || source.split(pluginDefine).length !== 2 || source.split(pluginDir).length !== 2) {
  throw new Error('The NSIS hooks or additional-plugins anchor is not singular.');
}
const patched = source
  .replace(pluginDefine, '')
  .replace(pluginDir, '')
  .replace(hooksAnchor, `${pluginDefine}${pluginDir}${hooksAnchor}`)
  .replace(welcomeAnchor, welcomeShow)
  .replace(confirmAnchor, confirmAnchor + '\n  ${If} $PassiveMode <> 1\n  ${AndIfNot} ${Silent}\n    System::Call "user32::SetWindowPos(p $HWNDPARENT, p -1, i 0, i 0, i 0, i 0, i 0x13)"\n    System::Call "user32::SetWindowPos(p $HWNDPARENT, p -2, i 0, i 0, i 0, i 0, i 0x13)"\n  ${EndIf}')
  .replace(anchor, guard + anchor)
  .replace(copyAnchor, '  StrCpy $CotalCopying 1\n\n' + copyAnchor);
writeFileSync(new URL('installer.nsi', base), patched);
console.log(`Prepared guarded NSIS template: ${fileURLToPath(new URL('installer.nsi', base))}`);
