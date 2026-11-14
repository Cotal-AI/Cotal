import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const source=readFileSync(new URL('./capture.ps1',import.meta.url),'utf8');
test('Windows census records every same-PID visible window before unchanged MainWindowHandle choice',()=>{
 const census=source.slice(source.indexOf('public static Observation[] VisibleWindows'),source.indexOf("'@"));
 assert.match(census,/pid != target \|\| !IsWindowVisible\(window\)/);
 for(const field of ['handle=window.ToInt64()', 'title=title.ToString()', 'windowClass=windowClass.ToString()', 'left=bounds.Left', 'bottom=bounds.Bottom'])assert.ok(census.includes(field));
 assert.match(census,/return true;\s*\}, IntPtr.Zero\)/);
 assert.doesNotMatch(census,/ShowWindow\(|SetForegroundWindow\(|PostMessage\(/);
 const observation=source.indexOf('$windowCensus = @()');
 const selected=source.indexOf('$window = $app.MainWindowHandle');
 assert.ok(observation>0 && selected>observation);
 assert.ok(source.indexOf("'.windows.jsonl'")<selected);
 assert.match(source,/windows=\$windowCensus; error=\$windowCensusError/);
 assert.match(source,/\$window = \$app.MainWindowHandle[\s\S]*?ShowWindow\(\$window, 9\)[\s\S]*?SetForegroundWindow\(\$window\)/);
});
