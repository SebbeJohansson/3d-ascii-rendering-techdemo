// Runs the browser's ray tracing worker (app/workers/raytrace.worker.ts) on a Node worker
// thread. It only touches `self.onmessage` and `self.postMessage`, so those are all it gets.
import { parentPort } from 'node:worker_threads'

const port = parentPort!

Object.assign(globalThis, {
  self: {
    postMessage: (message: unknown, { transfer }: { transfer: ArrayBuffer[] }) => port.postMessage(message, transfer),
    set onmessage(handler: (e: { data: unknown }) => void) {
      port.on('message', data => handler({ data }))
    },
  },
})

await import('../app/workers/raytrace.worker')
