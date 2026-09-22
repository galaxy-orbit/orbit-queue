import { describe, test, expect } from 'bun:test';
import { QueueService, MemoryQueueDriver, QueueModule } from './index';

describe('QueueService (memory driver)', () => {
  test('processes a job immediately', async () => {
    const queue = new QueueService({ pollIntervalMs: 10 });
    const processed: any[] = [];
    queue.register('email', { process: (job) => { processed.push(job.data); } });
    queue.start();
    await queue.add('email', { to: 'a@x.test' });
    await new Promise((r) => setTimeout(r, 100));
    queue.stop();
    expect(processed).toEqual([{ to: 'a@x.test' }]);
  });

  test('delayed jobs run later', async () => {
    const queue = new QueueService({ pollIntervalMs: 20 });
    const processed: any[] = [];
    queue.register('notify', { process: (job) => { void (processed.push(Date.now() - (job.createdAt as number))); } });
    queue.start();
    const t0 = Date.now();
    await queue.add('notify', { x: 1 }, { delayMs: 150 });
    await new Promise((r) => setTimeout(r, 300));
    queue.stop();
    expect(processed.length).toBe(1);
    expect(processed[0]).toBeGreaterThanOrEqual(120);
    expect(t0).toBeLessThan(Date.now());
  });

  test('retries with backoff then succeeds', async () => {
    const queue = new QueueService({ pollIntervalMs: 10, retryDelayMs: 10 });
    let attempts = 0;
    const failed: any[] = [];
    queue.register('flaky', {
      process: () => {
        attempts++;
        if (attempts < 3) throw new Error('not yet');
      },
      maxAttempts: 5,
    });
    queue.start();
    await queue.add('flaky', {});
    await new Promise((r) => setTimeout(r, 250));
    queue.stop();
    expect(attempts).toBe(3);
  });

  test('onFailed after maxAttempts', async () => {
    const queue = new QueueService({ pollIntervalMs: 10, retryDelayMs: 10 });
    const failures: any[] = [];
    queue.register('always-fails', {
      process: () => { throw new Error('kaput'); },
      onFailed: (job, err) => failures.push({ attempts: job.attempts, message: err.message }),
      maxAttempts: 2,
    });
    queue.start();
    await queue.add('always-fails', {});
    await new Promise((r) => setTimeout(r, 250));
    queue.stop();
    expect(failures.length).toBe(1);
    expect(failures[0].attempts).toBe(2);
    expect(failures[0].message).toBe('kaput');
  });

  test('processOnce for deterministic testing', async () => {
    const queue = new QueueService({ retryDelayMs: 10 });
    const processed: any[] = [];
    queue.register('task', { process: (job) => { processed.push(job.data); } });
    await queue.add('task', { n: 1 });
    expect(await queue.count()).toBe(1);
    const ran = await queue.processOnce();
    expect(ran).toBe(true);
    expect(processed).toEqual([{ n: 1 }]);
    expect(await queue.count()).toBe(0);
    expect(await queue.processOnce()).toBe(false);
  });

  test('start/stop idempotent', () => {
    const queue = new QueueService();
    queue.start();
    queue.start();
    expect(queue.isRunning()).toBe(true);
    queue.stop();
    queue.stop();
    expect(queue.isRunning()).toBe(false);
  });

  test('jobs in separate queues do not cross-pollinate', async () => {
    const queue = new QueueService({ retryDelayMs: 5 });
    const emails: any[] = [];
    const reports: any[] = [];
    queue.register('email', { process: (job) => { emails.push(job.data); } }, 'emails');
    queue.register('report', { process: (job) => { reports.push(job.data); } }, 'reports');
    await queue.add('email', { to: 'a' }, { queue: 'emails' });
    await queue.add('report', { day: 1 }, { queue: 'reports' });
    await queue.processOnce('emails');
    await queue.processOnce('reports');
    expect(emails).toEqual([{ to: 'a' }]);
    expect(reports).toEqual([{ day: 1 }]);
  });
});

describe('QueueModule', () => {
  test('provides QueueService', async () => {
    const { OrbitFactory, Module } = await import('@galaxy-stack/orbit-core');
    @Module({ imports: [QueueModule.forRoot({ pollIntervalMs: 20 })] })
    class M {}
    const app = await OrbitFactory.create(M);
    const queue = await app.getContainer().resolve(QueueService);
    expect(queue.isRunning()).toBe(false);
    queue.start();
    queue.stop();
  });

  test('accepts a custom driver', async () => {
    const { OrbitFactory, Module } = await import('@galaxy-stack/orbit-core');
    const driver = new MemoryQueueDriver();
    @Module({ imports: [QueueModule.forRoot({ driver })] })
    class M {}
    const app = await OrbitFactory.create(M);
    const queue = await app.getContainer().resolve(QueueService);
    const seen: any[] = [];
    queue.register('x', { process: (job) => { seen.push(job.data); } });
    await queue.add('x', { hello: 1 });
    await queue.processOnce();
    expect(seen).toEqual([{ hello: 1 }]);
  });
});
