import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const solc = require('solc') as { version(): string; compile(input: string): string };
export interface ContractArtifact {
  contractName: string;
  compiler: string;
  evmVersion: string;
  abi: readonly Record<string, unknown>[];
  bytecode: `0x${string}`;
  deployedBytecode: `0x${string}`;
  immutableReferences: Record<string, { start: number; length: number }[]>;
}
export function compileContracts(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')): Record<string, ContractArtifact> {
  const folder = path.join(root, 'contracts');
  const sources = Object.fromEntries(fs.readdirSync(folder).filter(name => name.endsWith('.sol'))
    .sort().map(name => [name, { content: fs.readFileSync(path.join(folder, name), 'utf8') }]));
  const input = { language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } }
  }};
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts?: Record<string, Record<string, { abi: readonly Record<string, unknown>[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> } } }>>;
  };
  const errors = output.errors?.filter(item => item.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join('\n'));
  for (const warning of output.errors ?? []) console.warn(warning.formattedMessage);
  const artifacts: Record<string, ContractArtifact> = {};
  fs.mkdirSync(path.join(folder, 'artifacts'), { recursive: true });
  for (const contracts of Object.values(output.contracts ?? {})) for (const [name, contract] of Object.entries(contracts)) {
    if (!contract.evm.bytecode.object) continue;
    const artifact: ContractArtifact = {
      contractName: name, compiler: solc.version(), evmVersion: 'paris', abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`, deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
      immutableReferences: contract.evm.deployedBytecode.immutableReferences
    };
    artifacts[name] = artifact;
    fs.writeFileSync(path.join(folder, 'artifacts', `${name}.json`), JSON.stringify(artifact, null, 2) + '\n');
  }
  if (artifacts.SoleilVault) {
    fs.mkdirSync(path.join(root, 'public', 'contracts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public', 'contracts', 'SoleilVault.json'), JSON.stringify(artifacts.SoleilVault, null, 2) + '\n');
  }
  return artifacts;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifacts = compileContracts();
  console.log(`Compiled ${Object.keys(artifacts).join(', ')} with ${solc.version()} (Paris target)`);
}


