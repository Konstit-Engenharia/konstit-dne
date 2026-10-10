import { Database } from 'bun:sqlite';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  relative,
} from 'node:path';
import {
  startAddressSearchWorker,
  type AddressSearchSnapshot,
  type AddressSearchWorkerData,
  type AddressSearchWorkerReply,
  type AddressSearchWorkerScope,
} from '../src/address-search-worker-runtime.ts';
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
import {
  buildAddressSearchIndex,
  DneAddressSearch,
  DneAddressSearchPool,
  DneAddressSearchPoolClosedError,
  DneAddressSearchQueueFullError,
  DneAddressSearchWorkerError,
  DneBinaryDatabaseReader,
  type AddressSearchOptions,
} from '../src/library.ts';
import { buildSchema } from '../src/schema.ts';
import { prepareDatabaseForLoad } from '../src/sqlite-db-schema.ts';
import { captureRejection } from './assertions.ts';

const directory = mkdtempSync(join(tmpdir(), 'dne-search-pool with spaces-'));
const databasePath = join(directory, 'dne.bin');
const indexPath = join(directory, 'dne.search.bin');
let database: DneBinaryDatabaseReader;
let search: DneAddressSearch;

beforeAll(async () => {
  const sqlitePath = join(directory, 'dne.db');
  const sqlite = new Database(sqlitePath);
  prepareDatabaseForLoad(sqlite, buildSchema({ cep_unificado: 'dne' }));
  for (let id = 0; id < 96; id++) {
    sqlite.run(
      `INSERT INTO dne
      (cep, logradouro, complemento, municipio, municipio_cod_ibge, uf, localidade_situacao, localidade_tipo)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'M')`,
      [
        String(10000000 + id),
        id % 2 ? 'Rua Rubens Meireles' : 'Avenida Paulista',
        `trecho ${id}`,
        id < 64 ? 'São Paulo' : 'Rio de Janeiro',
        id < 64 ? 3550308 : 3304557,
        id < 64 ? 'SP' : 'RJ',
      ],
    );
  }
  sqlite.close();
  await buildBinaryDatabase(sqlitePath, databasePath);
  database = new DneBinaryDatabaseReader(databasePath);
  const bytes = buildAddressSearchIndex(database);
  await Bun.write(indexPath, bytes);
  search = new DneAddressSearch(database, bytes);
});

afterAll(() => {
  search?.close();
  database?.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Fault injection uses a real worker; production callers cannot access the slots through the public type. */
function firstWorker(pool: DneAddressSearchPool): Worker {
  return (pool as unknown as { slots: [{ worker: Worker; }]; }).slots[0].worker;
}

describe('address search worker pool', () => {
  test('revokes every blob URL after draining and closing, including repeated pool creation', async () => {
    const create = spyOn(URL, 'createObjectURL');
    const revoke = spyOn(URL, 'revokeObjectURL');
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const pool = await DneAddressSearchPool.open({ databasePath, indexPath, workers: 3 });
        try {
          const queries = Array.from({ length: 12 }, () => pool.searchAddresses('rubens'));
          await pool.close();
          expect(await Promise.all(queries)).toEqual(Array.from({ length: 12 }, () => search.searchAddresses('rubens')));
          await pool.close();
        } finally {
          await pool.close();
        }
      }
      const urls = create.mock.results.map((result) => result.value as string);
      expect(urls).toHaveLength(6);
      expect(urls.every((url) => url.startsWith('blob:'))).toBe(true);
      expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(urls.sort());
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  test('revokes the blob URL if the native worker constructor throws', async () => {
    const create = spyOn(URL, 'createObjectURL');
    const revoke = spyOn(URL, 'revokeObjectURL');
    const scope = globalThis as unknown as { Worker: (...args: ConstructorParameters<typeof Worker>) => Worker; };
    const construct = spyOn(scope, 'Worker').mockImplementationOnce(() => { throw new Error('Worker creation failed'); });
    try {
      const error = await captureRejection(DneAddressSearchPool.open({ databasePath, indexPath }));
      expect(error).toBeInstanceOf(DneAddressSearchWorkerError);
      expect(error).toMatchObject({ cause: { message: 'Worker creation failed' } });
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith(create.mock.results[0]?.value);
    } finally {
      construct.mockRestore();
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  test('preserves every result and its order across concurrent searches and multiple workers', async () => {
    const pool = await DneAddressSearchPool.open({ databasePath, indexPath, workers: 2 });
    const cases: [string, AddressSearchOptions][] = [
      ['rubens mei', { uf: 'SP' }],
      ['paulista', { municipioCodIbge: 3304557, limit: 3 }],
      ['sao', { limit: 50 }],
      ['rubens 10000001', {}],
      ['10000002', {}],
      ['', {}],
      ['absent', {}],
    ];
    try {
      const queries = Array.from({ length: 56 }, (_, index) => cases[index % cases.length] as [string, AddressSearchOptions]);
      const results = await Promise.all(queries.map(([text, options,]) => pool.searchAddresses(text, options)));
      expect(results).toEqual(queries.map(([text, options,]) => search.searchAddresses(text, options)));
      expect(await captureRejection(pool.searchAddresses('paulista', { limit: 0 }))).toBeInstanceOf(RangeError);
      expect(await captureRejection(pool.searchAddresses('x'.repeat(257)))).toBeInstanceOf(RangeError);
      expect(await pool.searchAddresses('rubens')).toEqual(search.searchAddresses('rubens'));
    } finally {
      await pool.close();
    }
  });

  test('accepts relative paths and snapshots options at admission', async () => {
    const pool = await DneAddressSearchPool.open({
      databasePath: relative(process.cwd(), databasePath),
      indexPath: relative(process.cwd(), indexPath),
    });
    try {
      const options: AddressSearchOptions = { uf: 'SP', limit: 1 };
      const result = pool.searchAddresses('rubens', options);
      options.uf = 'RJ';
      expect(await result).toEqual(search.searchAddresses('rubens', { uf: 'SP', limit: 1 }));
    } finally {
      await pool.close();
    }
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid worker count %s', async (workers) => {
    expect(await captureRejection(DneAddressSearchPool.open({ databasePath, indexPath, workers }))).toBeInstanceOf(RangeError);
  });

  test.each([-1, 1.5, NaN, Infinity])('rejects invalid queue size %s', async (maxQueue) => {
    expect(await captureRejection(DneAddressSearchPool.open({ databasePath, indexPath, maxQueue }))).toBeInstanceOf(RangeError);
  });

  test('rejects empty paths before creating workers', async () => {
    expect(await captureRejection(DneAddressSearchPool.open({ indexPath: '' }))).toBeInstanceOf(TypeError);
    expect(await captureRejection(DneAddressSearchPool.open({ databasePath: ' ', indexPath }))).toBeInstanceOf(TypeError);
  });

  test('cleans up every worker when initialization fails', async () => {
    const invalidIndex = join(directory, 'invalid.search.bin');
    await Bun.write(invalidIndex, 'invalid');
    const create = spyOn(URL, 'createObjectURL');
    const revoke = spyOn(URL, 'revokeObjectURL');
    try {
      for (
        const options of [
          { databasePath: `${databasePath}.missing`, indexPath },
          { databasePath, indexPath: invalidIndex },
          { databasePath, indexPath: `${indexPath}.missing` },
        ]
      ) {
        expect(await captureRejection(DneAddressSearchPool.open({ ...options, workers: 2 }))).toBeInstanceOf(DneAddressSearchWorkerError);
      }
      expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(create.mock.results.map((result) => result.value as string).sort());
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  test('limits waiting searches and drains accepted work before closing', async () => {
    const pool = await DneAddressSearchPool.open({ databasePath, indexPath, maxQueue: 1 });
    const running = pool.searchAddresses('rubens');
    const queued = pool.searchAddresses('paulista');
    const overflow = pool.searchAddresses('sao').catch((error: unknown) => error);
    const closing = pool.close();
    expect(pool.close()).toBe(closing);
    expect(await captureRejection(pool.searchAddresses('rubens'))).toBeInstanceOf(DneAddressSearchPoolClosedError);
    expect(await overflow).toBeInstanceOf(DneAddressSearchQueueFullError);
    expect(await running).toEqual(search.searchAddresses('rubens'));
    expect(await queued).toEqual(search.searchAddresses('paulista'));
    await closing;
    await pool.close();
  });

  test('supports zero waiting slots and cancellation without releasing a busy worker early', async () => {
    const pool = await DneAddressSearchPool.open({ databasePath, indexPath, maxQueue: 0 });
    const controller = new AbortController();
    const reason = new Error('superseded');
    try {
      const running = pool.searchAddresses('rubens', { signal: controller.signal }).catch((error: unknown) => error);
      controller.abort(reason);
      const overflow = pool.searchAddresses('paulista').catch((error: unknown) => error);
      expect(await running).toBe(reason);
      expect(await overflow).toBeInstanceOf(DneAddressSearchQueueFullError);
      expect(await captureRejection(pool.searchAddresses('rubens', { signal: controller.signal }))).toBe(reason);
    } finally {
      await pool.close();
    }
  });

  test('removes aborted queued work, admits a replacement, and removes abort listeners', async () => {
    const pool = await DneAddressSearchPool.open({ databasePath, indexPath, maxQueue: 1 });
    const controller = new AbortController();
    const completedController = new AbortController();
    const removeListener = spyOn(completedController.signal, 'removeEventListener');
    try {
      const running = pool.searchAddresses('rubens', { signal: completedController.signal });
      const queued = pool.searchAddresses('paulista', { signal: controller.signal }).catch((error: unknown) => error);
      controller.abort();
      const replacement = pool.searchAddresses('sao');
      expect(await queued).toBeInstanceOf(DOMException);
      await running;
      expect(removeListener).toHaveBeenCalledTimes(1);
      completedController.abort();
      expect(await replacement).toEqual(search.searchAddresses('sao'));
    } finally {
      removeListener.mockRestore();
      await pool.close();
    }
  });

  test('fails pending searches and rejects new work if a worker reports an unexpected error', async () => {
    const pool = await DneAddressSearchPool.open({ databasePath, indexPath });
    const worker = firstWorker(pool);
    const pending = Promise.allSettled([pool.searchAddresses('rubens'), pool.searchAddresses('paulista')]);
    worker.dispatchEvent(new ErrorEvent('error', { error: new Error('simulated worker crash') }));
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'result', rows: [] } }));
    worker.dispatchEvent(new ErrorEvent('error', { message: 'duplicate error' }));
    const results = await pending;
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(DneAddressSearchWorkerError);
      }
    }
    expect(await captureRejection(pool.searchAddresses('rubens'))).toBeInstanceOf(DneAddressSearchWorkerError);
    await pool.close();
  });

  test('detects an unexpected worker exit even when no search is running', async () => {
    const pool = await DneAddressSearchPool.open({ databasePath, indexPath });
    const worker = firstWorker(pool);
    const closed = new Promise<void>((resolve) => worker.addEventListener('close', () => resolve(), { once: true }));
    worker.terminate();
    await closed;
    expect(await captureRejection(pool.searchAddresses('rubens'))).toBeInstanceOf(DneAddressSearchWorkerError);
    await pool.close();
  });

  test('rejects searches and closes the pool if dispatch fails', async () => {
    const pool = await DneAddressSearchPool.open({ databasePath, indexPath });
    const post = spyOn(firstWorker(pool), 'postMessage').mockImplementation(() => {
      throw new Error('send failed');
    });
    try {
      expect(await captureRejection(pool.searchAddresses('rubens'))).toBeInstanceOf(DneAddressSearchWorkerError);
    } finally {
      post.mockRestore();
      await pool.close();
    }
  });

  test('cleans up a worker if sending its initialization message fails', async () => {
    const post = spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(() => {
      throw new Error('initialization send failed');
    });
    try {
      expect(await captureRejection(DneAddressSearchPool.open({ databasePath, indexPath }))).toBeInstanceOf(DneAddressSearchWorkerError);
    } finally {
      post.mockRestore();
    }
  });

  test('rejects a corrupt shared index in additional workers and closes the whole pool', async () => {
    // oxlint-disable-next-line typescript/unbound-method -- The mock explicitly binds each call to its worker.
    const original = Worker.prototype.postMessage;
    const post = spyOn(Worker.prototype, 'postMessage').mockImplementation(function(this: Worker, message: unknown) {
      const data = message as AddressSearchWorkerData;
      original.call(this, data.type === 'init' ? { ...data, snapshot: { ...data.snapshot, index: new SharedArrayBuffer(1) } } : message);
    });
    try {
      const failure = await captureRejection(DneAddressSearchPool.open({ databasePath, indexPath, workers: 3 }));
      expect(failure).toBeInstanceOf(DneAddressSearchWorkerError);
      expect((failure as Error).cause).toMatchObject({ message: 'Invalid address search index header' });
    } finally {
      post.mockRestore();
    }
  });

  test('waits for native closure when the graceful shutdown message cannot be sent', async () => {
    const pool = await DneAddressSearchPool.open({ databasePath, indexPath });
    const worker = firstWorker(pool);
    let closed = false;
    worker.addEventListener('close', () => { closed = true; }, { once: true });
    const post = spyOn(worker, 'postMessage').mockImplementation(() => {
      throw new Error('shutdown send failed');
    });
    try {
      await pool.close();
      expect(closed).toBe(true);
    } finally {
      post.mockRestore();
      await pool.close();
    }
  });
});

test('worker runtime sends readiness, results, and recoverable errors through the native handler', () => {
  const replies: AddressSearchWorkerReply[] = [];
  const scope: AddressSearchWorkerScope = {
    onmessage: null,
    postMessage: (reply: AddressSearchWorkerReply) => { replies.push(reply); },
  };
  startAddressSearchWorker(scope, { type: 'load', databasePath, indexPath });
  scope.onmessage?.(new MessageEvent('message', { data: { type: 'search', text: 'rubens', options: {} } }));
  scope.onmessage?.(new MessageEvent('message', { data: { type: 'search', text: 'rubens', options: { limit: 0 } } }));
  expect(replies[0]).toMatchObject({ type: 'ready', snapshot: { database: expect.any(SharedArrayBuffer), index: expect.any(SharedArrayBuffer) } });
  expect(replies[1]).toEqual({ type: 'result', rows: search.searchAddresses('rubens') });
  expect(replies[2]?.type).toBe('error');
  scope.onmessage?.(new MessageEvent('message', { data: { type: 'close' } }));
  expect(scope.onmessage).toBeNull();
});

test('worker runtime releases the reader if index validation fails', () => {
  const close = spyOn(DneBinaryDatabaseReader.prototype, 'close');
  const scope: AddressSearchWorkerScope = { onmessage: null, postMessage() {} };
  const bytes = new SharedArrayBuffer(1);
  try {
    let snapshot: AddressSearchSnapshot | undefined;
    scope.postMessage = (reply: AddressSearchWorkerReply) => {
      if (reply.type === 'ready') snapshot = reply.snapshot;
    };
    startAddressSearchWorker(scope, { type: 'load', databasePath, indexPath });
    scope.onmessage?.(new MessageEvent('message', { data: { type: 'close' } }));
    close.mockClear();
    assert(snapshot);
    const sharedDatabase = snapshot.database;
    expect(() => startAddressSearchWorker(scope, { type: 'init', snapshot: { database: sharedDatabase, index: bytes } })).toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
  }
});

test('loads once and passes the same shared buffers to every additional native worker', async () => {
  const post = spyOn(Worker.prototype, 'postMessage');
  const pool = await DneAddressSearchPool.open({ databasePath, indexPath, workers: 3 });
  try {
    const messages = post.mock.calls.map(([data]) => data as AddressSearchWorkerData);
    expect(messages.filter((data) => data.type === 'load')).toHaveLength(1);
    const snapshots = messages.filter((data) => data.type === 'init').map((data) => data.snapshot);
    expect(snapshots).toHaveLength(2);
    const snapshot = snapshots[0];
    assert(snapshot);
    expect(snapshot.database).toBeInstanceOf(SharedArrayBuffer);
    expect(snapshot.index).toBeInstanceOf(SharedArrayBuffer);
    expect(snapshots[1]?.database).toBe(snapshot.database);
    expect(snapshots[1]?.index).toBe(snapshot.index);
    const before = [snapshot.database, snapshot.index].map((buffer) => Bun.hash(new Uint8Array(buffer)));
    const reader = new DneBinaryDatabaseReader(snapshot.database);
    const sharedSearch = new DneAddressSearch(reader, snapshot.index);
    try {
      expect((reader as unknown as { bytes: Uint8Array; }).bytes.buffer).toBe(snapshot.database);
      expect((sharedSearch as unknown as { index: { data: DataView; }; }).index.data.buffer).toBe(snapshot.index);
      expect(await Promise.all(Array.from({ length: 30 }, () => pool.searchAddresses('rubens'))))
        .toEqual(Array.from({ length: 30 }, () => sharedSearch.searchAddresses('rubens')));
      expect([snapshot.database, snapshot.index].map((buffer) => Bun.hash(new Uint8Array(buffer)))).toEqual(before);
      sharedSearch.close();
      reader.close();
      expect(await pool.searchAddresses('paulista')).toEqual(search.searchAddresses('paulista'));
    } finally {
      sharedSearch.close();
      reader.close();
    }
  } finally {
    post.mockRestore();
    await pool.close();
  }
});

test('Bun.serve example validates HTTP queries, returns search results, and exits gracefully', async () => {
  const child = Bun.spawn([process.execPath, 'examples/address-search-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DNE_DATABASE: databasePath, DNE_SEARCH_INDEX: indexPath, PORT: '0', HOST: '127.0.0.1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  try {
    const { value } = await reader.read();
    const output = new TextDecoder().decode(value);
    const baseUrl = output.match(/http:\/\/\S+/)?.[0];
    expect(baseUrl).toBeDefined();
    const response = await fetch(new URL('/addresses?q=rubens+mei&uf=SP&limit=3', baseUrl));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ addresses: search.searchAddresses('rubens mei', { uf: 'SP', limit: 3 }) });
    const municipality = await fetch(new URL('/addresses?q=paulista&municipioCodIbge=3304557', baseUrl));
    expect(await municipality.json()).toEqual({ addresses: search.searchAddresses('paulista', { municipioCodIbge: 3304557 }) });
    const absent = await fetch(new URL('/addresses?q=absent', baseUrl));
    expect(await absent.json()).toEqual({ addresses: [] });
    for (
      const query of [
        '',
        'q=ab',
        `q=${'x'.repeat(257)}`,
        'q=rubens&uf=XX',
        'q=rubens&limit=0',
        'q=rubens&limit=1.5',
        'q=rubens&municipioCodIbge=no',
      ]
    ) {
      expect((await fetch(new URL(`/addresses?${query}`, baseUrl))).status).toBe(400);
    }
    expect((await fetch(new URL('/missing', baseUrl))).status).toBe(404);
    const post = await fetch(new URL('/addresses?q=rubens', baseUrl), { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');
  } finally {
    reader.releaseLock();
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(await stderr).not.toContain('error:');
  }
});
