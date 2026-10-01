import { FSST_SYMBOL_TABLE_SIZE } from './binary-db-format.ts';

const FSST_CODE_COUNT = 255;
const FSST_ESCAPE = 255;
const FSST_MAX_SYMBOL_LENGTH = 8;
const FSST_MAX_COMPRESSED_LENGTH = 510;
const SAMPLE_LIMIT = 64 * 1024;
// Evaluate different shares of the 255 codes, keeping the best measured sample size.
const MULTI_SYMBOL_BUDGETS = [64, 128, 160, 192, 224] as const;

type Candidate = {
  key: string;
  length: number;
  score: number;
};

type SymbolTable = {
  symbols: Uint8Array;
  trie: TrieNode;
};

type TrieNode = {
  code: number;
  children: Map<number, TrieNode>;
};

export type EncodedFsstSuffixes = {
  compressedLengths: Uint8Array;
  lengthWidth: 1 | 2;
  payload: Uint8Array;
  symbols: Uint8Array;
};

/** A compact view over front-coded suffixes, avoiding one allocation per string. */
export type FsstSuffixSource = {
  count: number;
  get(index: number): Uint8Array;
  totalBytes: number;
};

/**
 * Encodes UTF-8 suffixes using the FSST byte format with a deterministic
 * bounded trainer. The table uses codes 0..254; code 255 is always an escape.
 */
export function encodeFsstSuffixes(suffixes: readonly Uint8Array[]): EncodedFsstSuffixes {
  return encodeFsstSuffixSource({
    count: suffixes.length,
    get: (index) => suffixes[index] ?? new Uint8Array(),
    totalBytes: suffixes.reduce((sum, suffix) => sum + suffix.byteLength, 0),
  });
}

/** Encode a compact suffix view produced directly from a plain dictionary. */
export function encodeFsstSuffixSource(source: FsstSuffixSource): EncodedFsstSuffixes {
  if (!source.count) {
    throw new Error('Cannot train FSST with an empty dictionary');
  }
  const sample = selectSample(source);
  const table = chooseTable(collectCandidates(sample), collectSingleBytes(sample), sample);
  const encoded = encodeAll(source, table);
  const compressedLengths = encoded.maxLength <= 0xff
    ? Uint8Array.from(encoded.lengths)
    : packLengths16(encoded.lengths);
  return {
    compressedLengths,
    lengthWidth: encoded.maxLength <= 0xff ? 1 : 2,
    payload: encoded.payload,
    symbols: table.symbols,
  };
}

function selectSample(suffixes: FsstSuffixSource) {
  const total = suffixes.totalBytes;
  const sample: Uint8Array[] = [];
  const target = Math.min(suffixes.count, SAMPLE_LIMIT, Math.ceil(SAMPLE_LIMIT / Math.max(1, total / suffixes.count)));
  const stride = suffixes.count / Math.max(1, target);
  let random = 0x9e37_79b9;
  let size = 0;
  for (let sampleIndex = 0; sampleIndex < target && size < SAMPLE_LIMIT; sampleIndex++) {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    const jitter = Math.floor((random / 0x1_0000_0000) * Math.max(1, stride));
    const index = Math.min(suffixes.count - 1, Math.floor(sampleIndex * stride) + jitter);
    const suffix = suffixes.get(index);
    if (!suffix?.byteLength) {
      continue;
    }
    const remaining = SAMPLE_LIMIT - size;
    sample.push(suffix.byteLength <= remaining ? suffix : suffix.subarray(0, remaining));
    size += Math.min(suffix.byteLength, remaining);
  }
  return sample;
}

function collectCandidates(sample: readonly Uint8Array[]) {
  const counts = new Map<string, number>();
  for (const bytes of sample) {
    for (let start = 0; start + 1 < bytes.byteLength; start++) {
      let key = '';
      const limit = Math.min(bytes.byteLength, start + FSST_MAX_SYMBOL_LENGTH);
      for (let end = start; end < limit; end++) {
        key += String.fromCharCode(bytes[end] ?? 0);
        const length = end - start + 1;
        if (length >= 2) {
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const candidates: Candidate[] = [];
  for (const [key, count,] of counts) {
    const length = key.length;
    candidates.push({
      key,
      length,
      score: count * (length - 1),
    });
  }
  candidates.sort(compareCandidates);
  return candidates.slice(0, 4096);
}

function collectSingleBytes(sample: readonly Uint8Array[]) {
  const counts = new Uint32Array(256);
  for (const bytes of sample) {
    for (const byte of bytes) {
      counts[byte] = (counts[byte] ?? 0) + 1;
    }
  }
  return Array.from({ length: 256 }, (_, byte) => byte)
    .filter((byte) => (counts[byte] ?? 0) > 0)
    .sort((left, right) => (counts[right] ?? 0) - (counts[left] ?? 0) || left - right);
}

function chooseTable(candidates: readonly Candidate[], singleBytes: readonly number[], sample: readonly Uint8Array[]) {
  const byteTable = createTable(singleBytes.slice(0, FSST_CODE_COUNT).map((byte) => Uint8Array.of(byte)));
  let best = { table: byteTable, size: measureSample(sample, byteTable).size };
  for (const multiCount of MULTI_SYMBOL_BUDGETS) {
    let multi = candidates.slice(0, multiCount);
    let nextCandidate = multi.length;
    const singles = singleBytes.slice(0, FSST_CODE_COUNT - multi.length).map((byte) => Uint8Array.of(byte));
    // Raw n-gram counts include overlaps. Retire symbols that greedy encoding
    // never uses and spend those slots on new candidates, preserving byte codes.
    for (let pass = 0; pass < 4; pass++) {
      const symbols = multi.map((candidate) => bytesFromKey(candidate.key)).concat(singles);
      const table = createTable(symbols);
      const measured = measureSample(sample, table);
      if (measured.size < best.size) {
        best = { table, size: measured.size };
      }
      const retained = multi.filter((_, code) => (measured.uses[code] ?? 0) > 0);
      if (retained.length === multi.length || nextCandidate === candidates.length) {
        break;
      }
      while (retained.length < multiCount && nextCandidate < candidates.length) {
        const candidate = candidates[nextCandidate++];
        if (candidate) {
          retained.push(candidate);
        }
      }
      multi = retained;
    }
  }
  return best.table;
}

function createTable(symbols: readonly Uint8Array[]): SymbolTable {
  const table = new Uint8Array(FSST_SYMBOL_TABLE_SIZE);
  const trie = createTrieRoot();
  for (const [code, symbol,] of symbols.entries()) {
    if (code >= FSST_CODE_COUNT || symbol.byteLength < 1 || symbol.byteLength > FSST_MAX_SYMBOL_LENGTH) {
      break;
    }
    table[code] = symbol.byteLength;
    table.set(symbol, FSST_CODE_COUNT + code * FSST_MAX_SYMBOL_LENGTH);
    addTrieSymbol(trie, symbol, code);
  }
  return { symbols: table, trie };
}

function createTrieRoot(): TrieNode {
  return { code: -1, children: new Map() };
}

function addTrieSymbol(root: TrieNode, symbol: Uint8Array, code: number) {
  let node = root;
  for (const byte of symbol) {
    let child = node.children.get(byte);
    if (!child) {
      child = createTrieRoot();
      node.children.set(byte, child);
    }
    node = child;
  }
  node.code = code;
}

function measureSample(values: readonly Uint8Array[], table: SymbolTable) {
  let size = 0;
  const uses = new Uint32Array(FSST_CODE_COUNT);
  for (const value of values) {
    let cursor = 0;
    while (cursor < value.byteLength) {
      const match = longestMatch(value, cursor, table.trie);
      if (match) {
        size++;
        uses[match.code] = (uses[match.code] ?? 0) + 1;
        cursor += match.length;
      } else {
        size += 2;
        cursor++;
      }
    }
  }
  return { size, uses };
}

function encodeAll(values: FsstSuffixSource, table: SymbolTable) {
  const lengths = new Uint32Array(values.count);
  const capacity = values.totalBytes * 2;
  const payload = new Uint8Array(capacity);
  let cursor = 0;
  let maxLength = 0;
  for (let index = 0; index < values.count; index++) {
    const value = values.get(index);
    const start = cursor;
    cursor = writeEncoded(value, table, payload, cursor);
    const length = cursor - start;
    lengths[index] = length;
    maxLength = Math.max(maxLength, length);
    if (length > FSST_MAX_COMPRESSED_LENGTH) {
      throw new Error(`FSST compressed suffix exceeds ${FSST_MAX_COMPRESSED_LENGTH} bytes: ${length}`);
    }
  }
  return { lengths, maxLength, payload: payload.slice(0, cursor) };
}

function writeEncoded(value: Uint8Array, table: SymbolTable, output: Uint8Array, outputOffset: number) {
  let cursor = 0;
  let target = outputOffset;
  while (cursor < value.byteLength) {
    const match = longestMatch(value, cursor, table.trie);
    if (match) {
      output[target++] = match.code;
      cursor += match.length;
    } else {
      output[target++] = FSST_ESCAPE;
      output[target++] = value[cursor++] ?? 0;
    }
  }
  return target;
}

function longestMatch(value: Uint8Array, offset: number, root: TrieNode) {
  let node = root;
  let bestCode = -1;
  let bestLength = 0;
  const end = Math.min(value.byteLength, offset + FSST_MAX_SYMBOL_LENGTH);
  for (let index = offset; index < end; index++) {
    const child = node.children.get(value[index] ?? 0);
    if (!child) {
      break;
    }
    node = child;
    if (node.code >= 0) {
      bestCode = node.code;
      bestLength = index - offset + 1;
    }
  }
  return bestCode < 0 ? undefined : { code: bestCode, length: bestLength };
}

function bytesFromKey(key: string) {
  const bytes = new Uint8Array(key.length);
  for (let index = 0; index < key.length; index++) {
    bytes[index] = key.charCodeAt(index);
  }
  return bytes;
}

function compareCandidates(left: Candidate, right: Candidate) {
  return right.score - left.score || right.length - left.length || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function packLengths16(lengths: Uint32Array) {
  const packed = new Uint8Array(lengths.length * 2);
  const data = new DataView(packed.buffer);
  for (let index = 0; index < lengths.length; index++) {
    data.setUint16(index * 2, lengths[index] ?? 0, true);
  }
  return packed;
}
