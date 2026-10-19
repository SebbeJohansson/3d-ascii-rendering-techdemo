import { Worker } from 'node:worker_threads'
import { createWorkerTracer, type TraceWorker, type TracerEvents } from '../app/lib/tracers'

/** A worker thread dressed up as the Web Worker the tracer expects. */
function spawnNodeWorker(): TraceWorker {
  // From source under tsx this file is tracer.ts; bundled for npm it's the worker.js next to ascii.js.
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url))
  const adapter: TraceWorker = {
    postMessage: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
    onmessage: null,
    terminate: () => void worker.terminate(),
  }
  worker.on('message', data => adapter.onmessage?.({ data } as MessageEvent))
  worker.on('error', (error) => {
    throw error
  })
  return adapter
}

/** The browser's worker tracer, on Node worker threads: each traces an interleaved share of rows. */
export function createNodeTracer(events: TracerEvents, count: number) {
  return createWorkerTracer(events, count, spawnNodeWorker)
}
