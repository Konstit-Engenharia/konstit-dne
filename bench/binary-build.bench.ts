import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourcePath, writerModulePath, outputPath,] = Bun.argv.slice(2);
if (!sourcePath || !writerModulePath || !outputPath) {
  throw new Error('Usage: bun bench/binary-build.bench.ts <source.db> <writer.ts> <output.bin>');
}
const writer = await import(pathToFileURL(resolve(writerModulePath)).href) as {
  buildBinaryDatabase: (source: string, destination: string) => Promise<number>;
};
const start = performance.now();
const rows = await writer.buildBinaryDatabase(sourcePath, outputPath);
const elapsedMs = performance.now() - start;
const file = Bun.file(outputPath);
const sha256 = new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
console.log(
  JSON.stringify({ runtime: Bun.version, rows, elapsedMs, bytes: file.size, sha256, sourcePath, writerModulePath, outputPath }, null, 2),
);
