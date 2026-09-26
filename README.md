<div align="center">

# @galaxy-stack/orbit-queue

**Job queue for Orbit** — pluggable drivers (memory included), retries with backoff, delayed jobs.

[![npm version](https://img.shields.io/npm/v/@galaxy-stack/orbit-queue.svg)](https://www.npmjs.com/package/@galaxy-stack/orbit-queue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

Part of the [Orbit framework](https://github.com/galaxy-orbit/orbit) — a NestJS-style backend framework for [Bun](https://bun.sh).

## Installation

```bash
bun add @galaxy-stack/orbit-queue
```

## Usage

```ts
import { QueueModule, QueueService, Module } from '@galaxy-stack/orbit-queue';

@Module({
  imports: [QueueModule.forRoot({ concurrency: 2, retryDelayMs: 500 })],
})
export class AppModule {}

// anywhere with DI:
constructor(private queue: QueueService) {}

// register a worker
this.queue.register('send-email', {
  process: async (job) => { /* job.data */ },
  onFailed: (job, err) => { /* dead-letter */ },
  maxAttempts: 5,
});
this.queue.start();
await this.queue.add('send-email', { to: 'user@x.test' }, { delayMs: 5000 });
```

## Redis driver

Uses Bun's native Redis client — no extra dependency:

```ts
QueueModule.forRoot({ driver: 'redis', redisUrl: 'redis://localhost:6379', redisPrefix: 'orbit:queue' })
```

Atomic claims (Lua EVAL) so multiple workers never receive the same job. Jobs live in a ZSET scored by `runAt`.

Memory driver included for local development; implement `QueueDriver` for other backends.

## License

MIT
