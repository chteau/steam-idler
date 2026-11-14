// Production launcher: compiles TypeScript, then runs the daemon in this same process.
// One process instead of `npm start` + child keeps ~60 MB of RAM free on small plans,
// and works on hosts that have no separate build step.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tsc = fileURLToPath(new URL('./node_modules/typescript/bin/tsc', import.meta.url));
const project = fileURLToPath(new URL('./tsconfig.json', import.meta.url));

if (process.env.SKIP_BUILD !== '1') {
  const result = spawnSync(process.execPath, [tsc, '-p', project], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    process.stderr.write(`Build failed (${result.error?.message ?? `exit ${result.status}`}); not starting.\n`);
    process.exit(1);
  }
}

await import('./dist/index.js');
