import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../server/app';
mkdirSync(resolve('.runtime'), { recursive: true });
const directory = mkdtempSync(resolve('.runtime/e2e-'));
const { app, close } = createApp({ databasePath: resolve(directory, 'soleil.sqlite'), demoEnabled: true, appOrigin: 'http://127.0.0.1:3101', staticDirectory: resolve('dist') });
const server = app.listen(3101, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { close(); process.exit(0); }));
