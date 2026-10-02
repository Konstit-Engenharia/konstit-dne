import { fileURLToPath } from 'node:url';
import asset from '../data/dne.bin' with { type: 'file' };

/** Asset path resolved by Bun at runtime or rewritten by its bundler. */
const databasePath = fileURLToPath(new URL(asset, import.meta.url));
export default databasePath;
