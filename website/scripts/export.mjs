import { rmSync, renameSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
renameSync('out', 'dist');
