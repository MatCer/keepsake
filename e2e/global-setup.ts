import { execFileSync } from 'node:child_process';

export default async function globalSetup() {
  execFileSync('pnpm', ['wxt', 'build'], { stdio: 'inherit', env: { ...process.env, KEEPSAKE_E2E: '1' } });
  const up = await fetch('http://127.0.0.1:3999/api/health').then((r) => r.ok, () => false);
  if (!up) execFileSync('scripts/karakeep-local.sh', ['up'], { stdio: 'inherit' });
}
