export interface RuntimeArtifact { deployedBytecode?: string; immutableReferences?: Record<string, { start: number; length: number }[]>; }
export function matchesVaultRuntime(actual: string, artifact: RuntimeArtifact) {
  const expected = artifact.deployedBytecode;
  if (!expected || !/^0x[0-9a-f]+$/i.test(actual) || actual.length !== expected.length) return false;
  const a = actual.slice(2).toLowerCase().split(''); const b = expected.slice(2).toLowerCase().split('');
  for (const references of Object.values(artifact.immutableReferences ?? {})) {
    for (const { start, length } of references) {
      if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0 || (start + length) * 2 > a.length) return false;
      for (let index = start * 2; index < (start + length) * 2; index++) { a[index] = '0'; b[index] = '0'; }
    }
  }
  return a.join('') === b.join('');
}
