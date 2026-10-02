import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTestnetProof, type VaultArtifact } from '../src/lib/tempo-lab';
const artifact = JSON.parse(readFileSync(resolve('contracts/artifacts/SoleilVault.json'), 'utf8')) as VaultArtifact;
const evidence = await runTestnetProof(artifact, (step) => console.log(step));
mkdirSync(resolve('public'), { recursive: true });
writeFileSync(resolve('public/testnet-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
