import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { NativeTempoWorkspace } from '../server/native-tempo.js';
import { Store } from '../server/store.js';
const native = new NativeTempoWorkspace({ directory: process.env.SOLEIL_NATIVE_DIRECTORY ?? resolve('data/native-tempo') });
const store = new Store(process.env.SOLEIL_DATABASE_PATH ?? resolve('data/soleil.sqlite'));
try {
  console.log('Preparing persistent, isolated Tempo Moderato test wallets and vault. Free faucet funding is setup only.');
  const bundle = await native.provision('presentation_tempo');
  store.presentationUser('owner', bundle);
  const state = store.organization('presentation_tempo');
  const preflight = await native.preflight(state.company.id, state.invoices, state.workers);
  if (!preflight.ready || preflight.pendingTransactions.length) throw new Error('Presentation preflight is not ready. Preserve saved wallet/journal files and retry preparation.');
  mkdirSync(resolve('public'), { recursive: true });
  writeFileSync(resolve('public/presentation-evidence.json'), JSON.stringify(preflight, null, 2) + '\n');
  console.log(JSON.stringify(preflight, null, 2));
} finally { store.close(); native.close(); }
