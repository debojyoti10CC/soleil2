import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { NativeTempoWorkspace } from '../server/native-tempo.js';
import { Store } from '../server/store.js';
const native = new NativeTempoWorkspace({ directory: process.env.SOLEIL_NATIVE_DIRECTORY ?? resolve('data/native-tempo') });
const store = new Store(process.env.SOLEIL_DATABASE_PATH ?? resolve('data/soleil.sqlite'));
try {
  const state = store.organization('presentation_tempo');
  const result = await native.preflight(state.company.id, state.invoices, state.workers);
  writeFileSync(resolve('public/presentation-evidence.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready || result.pendingTransactions.length) process.exitCode = 1;
} finally { store.close(); native.close(); }
