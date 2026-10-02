import { resolve } from 'node:path';
import { createApp } from './app.js';
import { NativeTempoWorkspace } from './native-tempo.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const production = process.env.NODE_ENV === 'production';
const appOrigin = process.env.SOLEIL_APP_ORIGIN ?? process.env.APP_ORIGIN ?? (production ? `http://localhost:${port}` : 'http://localhost:5173');
const demoEnabled = (process.env.SOLEIL_DEMO_ENABLED ?? process.env.ALLOW_DEMO) === 'true';
const native = process.env.SOLEIL_NATIVE_ENABLED === 'true' ? new NativeTempoWorkspace({ directory: process.env.SOLEIL_NATIVE_DIRECTORY ?? resolve('data/native-tempo'), artifactPath: process.env.SOLEIL_NATIVE_ARTIFACT_PATH }) : undefined;
const { app, close } = createApp({
  databasePath: process.env.SOLEIL_DATABASE_PATH ?? process.env.DATABASE_PATH ?? resolve('data', 'soleil.sqlite'),
  demoEnabled,
  native,
  appOrigin,
  allowedOrigins: process.env.SOLEIL_ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? (production ? [appOrigin] : [appOrigin, 'http://127.0.0.1:5173', `http://localhost:${port}`, `http://127.0.0.1:${port}`]),
  publicConfig: {
    // Provider credentials stay server-side; a configuration flag is not production route approval.
    bridgeConfigured: false,
    solana: { rpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com', programId: process.env.SOLANA_PROGRAM_ID ?? null, mint: process.env.SOLANA_MINT ?? null },
    tempo: { rpcUrl: process.env.TEMPO_RPC_URL ?? 'https://rpc.moderato.tempo.xyz', chainId: Number(process.env.TEMPO_CHAIN_ID ?? 42431), vaultAddress: process.env.TEMPO_VAULT_ADDRESS ?? null, tokenAddress: process.env.TEMPO_TOKEN_ADDRESS ?? null },
  },
  staticDirectory: resolve('dist'),
});
const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Soleil listening at http://${process.env.HOST ?? '127.0.0.1'}:${port}; native testnet ${native ? 'enabled' : 'disabled'}; local simulation ${demoEnabled ? 'enabled' : 'disabled'}.`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(() => { close(); native?.close(); process.exit(0); }); });
