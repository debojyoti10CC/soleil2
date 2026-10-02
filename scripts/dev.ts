import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const root = process.cwd();
const devEnv = { ...process.env, NODE_USE_ENV_PROXY: '1', SOLEIL_NATIVE_ENABLED: process.env.SOLEIL_NATIVE_ENABLED ?? 'true', SOLEIL_DEMO_ENABLED: process.env.SOLEIL_DEMO_ENABLED ?? 'true', SOLEIL_APP_ORIGIN: process.env.SOLEIL_APP_ORIGIN ?? 'http://localhost:5173' };
const children = [
  spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', 'server/index.ts'], { cwd: root, stdio: 'inherit', env: devEnv }),
  spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit' }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (child.pid && process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const child of children) { child.on('error', (error) => { console.error(error.message); stop(1); }); child.on('exit', (code) => { if (!closing) stop(code ?? 1); }); }
