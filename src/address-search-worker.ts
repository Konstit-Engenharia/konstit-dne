import type { AddressSearchWorkerData, AddressSearchWorkerReply } from './address-search-worker-runtime.ts';

declare const self: Worker;

// Install the native handler before importing the runtime, including any module with top-level await.
self.onmessage = async ({ data }: MessageEvent<AddressSearchWorkerData>) => {
  try {
    const { startAddressSearchWorker } = await import('./address-search-worker-runtime.ts');
    startAddressSearchWorker(self, data);
  } catch (error) {
    const failure = error as Error;
    self.postMessage({ type: 'failed', error: { name: failure.name, message: failure.message } } satisfies AddressSearchWorkerReply);
    self.onmessage = null;
  }
};
