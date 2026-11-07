import {readFileSync, existsSync} from 'node:fs';
import * as esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: ['live/dashboard.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'live/dashboard.js',
  legalComments: 'eof',
  minify: true,
  metafile: true,
  banner: {
    js: '/* Read-only Base Sepolia dashboard. Built from dashboard.mjs. Public RPC reads only. No wallet and no signing. Bundled viem 2.38.3 (MIT). Dependency license notices are at the end of this file. */',
  },
});

const bundled = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const [input, info] of Object.entries(output.inputs)) {
    if (!info.bytesInOutput) continue;
    const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (match) bundled.add(match[1]);
  }
}

const notices = [];
for (const name of [...bundled].sort()) {
  const base = 'node_modules/' + name;
  const file = ['LICENSE', 'LICENSE.md', 'license'].map((leaf) => base + '/' + leaf).find((path) => existsSync(path));
  if (!file) continue;
  const text = readFileSync(file, 'utf8').trim().replaceAll('*/', '* /');
  notices.push('/* ' + name + '\n' + text + '\n*/');
}

const {appendFileSync} = await import('node:fs');
if (notices.length) appendFileSync('live/dashboard.js', '\n' + notices.join('\n') + '\n');
console.log('bundled packages:', [...bundled].sort().join(', '));
