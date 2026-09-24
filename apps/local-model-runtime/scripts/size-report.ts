import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/core/paths.js';

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(filePath);
    else if (entry.isFile()) total += (await stat(filePath)).size;
  }
  return total;
}

async function main(): Promise<void> {
  const modelBytes = await directoryBytes(path.join(projectRoot, 'models'));
  const wrapperBytes = await directoryBytes(path.join(projectRoot, 'node_modules', 'sherpa-onnx-node'));
  const nativePackage = `sherpa-onnx-${process.platform}-${process.arch}`;
  const nativeRuntimeBytes = await directoryBytes(path.join(projectRoot, 'node_modules', nativePackage));
  const servicePayloadPaths = [
    'dist/src', 'configs', 'schemas', 'keys', 'docs', 'openapi.yaml',
    'THIRD_PARTY_NOTICES.md', 'README.md', 'package.json',
  ];
  let servicePayloadBytes = 0;
  for (const relative of servicePayloadPaths) {
    const filePath = path.join(projectRoot, relative);
    const details = await stat(filePath);
    servicePayloadBytes += details.isDirectory() ? await directoryBytes(filePath) : details.size;
  }
  const lock = JSON.parse(await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dev?: boolean }>;
  };
  let productionDependenciesBytes = 0;
  for (const [relative, metadata] of Object.entries(lock.packages)) {
    if (!relative.startsWith('node_modules/') || metadata.dev) continue;
    try {
      productionDependenciesBytes += await directoryBytes(path.join(projectRoot, relative));
    } catch {
      // Optional packages for other platforms are intentionally absent.
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    servicePayloadBytes,
    productionDependenciesBytes,
    baseServiceBytes: servicePayloadBytes + productionDependenciesBytes,
    modelBytes,
    runtimeBytes: wrapperBytes + nativeRuntimeBytes,
    runtimePackage: nativePackage,
    combinedServiceAndModelBytes: servicePayloadBytes + productionDependenciesBytes + modelBytes,
  };
  const outputPath = path.join(projectRoot, 'reports', `size-${process.platform}-${process.arch}.json`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
