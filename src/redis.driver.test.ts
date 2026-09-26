import { describe, test, expect, afterAll } from 'bun:test';
import { RedisQueueDriver } from './drivers/redis.driver';
import { QueueService } from './queue';
import { QueueModule } from './queue.module';


// Skip the whole suite when Redis is unreachable
const redisGate = await (async () => {
  try {
    await Bun.redis.ping();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!redisGate)('RedisQueueDriver (requires redis on localhost:6379)', () => {
  const PREFIX = `orbit:test:${Date.now()}`;
  const driver = new RedisQueueDriver({ prefix: PREFIX });

  afterAll(async () => {
    await driver.clear('default');
    await driver.clear('emails');
    await driver.close?.();
  });

  test('add + claim (immediate job)', async () => {
    const job = {
      id: 'j1', queue: 'default', name: 'task', data: { n: 1 },
      attempts: 0, maxAttempts: 3, createdAt: Date.now(), runAt: Date.now(),
    };
    await driver.add(job);
    expect(await driver.count('default')).toBe(1);
    const claimed = await driver.claim('default');
    expect(claimed?.id).toBe('j1');
    expect(claimed?.data).toEqual({ n: 1 });
       expect(await driver.count('default')).toBe(0);
    expect(await driver.claim('default')).toBeNull();
  });

  test('delayed job is not claimable until due', async () => {
    const job = {
      id: 'delayed', queue: 'default', name: 'task', data: {},
      attempts: 0, maxAttempts: 1, createdAt: Date.now(), runAt: Date.now() + 300,
    };
    await driver.add(job);
    expect(await driver.claim('default')).toBeNull();
    await new Promise((r) => setTimeout(r, 350));
    const claimed = await driver.claim('default');
    expect(claimed?.id).toBe('delayed');
    expect(await driver.count('default')).toBe(0);
  });

  test('requeue makes the job claimable again after delay', async () => {
    const job = {
      id: 'retry', queue: 'default', name: 'task', data: {},
      attempts: 1, maxAttempts: 3, createdAt: Date.now(), runAt: Date.now(),
    };
    await driver.add(job);
    const claimed = await driver.claim('default');
    expect(claimed?.id).toBe('retry');
    await driver.requeue(claimed!, 50);
    expect(await driver.claim('default')).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect((await driver.claim('default'))?.id).toBe('retry');
  });

  test('end-to-end: QueueService + Redis driver', async () => {
    const svc = new QueueService({ driver, pollIntervalMs: 20, retryDelayMs: 20 });
    const processed: any[] = [];
    svc.register('email', { process: (job) => { processed.push(job.data); } });
    svc.start();
    await svc.add('email', { to: 'e2e@x.test' });
    await new Promise((r) => setTimeout(r, 200));
    svc.stop();
    expect(processed).toEqual([{ to: 'e2e@x.test' }]);
  });

  test('end-to-end: retries across redis requeue', async () => {
    const svc = new QueueService({ driver, pollIntervalMs: 15, retryDelayMs: 15 });
    let attempts = 0;
    svc.register('flaky', {
      process: () => { attempts++; if (attempts < 3) throw new Error('nope'); },
      maxAttempts: 4,
    });
    svc.start();
    await svc.add('flaky', {});
    await new Promise((r) => setTimeout(r, 300));
    svc.stop();
    expect(attempts).toBe(3);
  });

  test('QueueModule.forRoot with driver redis', async () => {
    const { OrbitFactory, Module } = await import('@galaxy-stack/orbit-core');
    @Module({ imports: [QueueModule.forRoot({ driver: 'redis', redisPrefix: PREFIX })] })
    class M {}
    const app = await OrbitFactory.create(M);
    const svc = await app.getContainer().resolve(QueueService);
    const seen: any[] = [];
    svc.register('x', { process: (job) => { seen.push(job.data); } });
    await svc.add('x', { via: 'module' });
    await svc.processOnce();
    expect(seen).toEqual([{ via: 'module' }]);
    await driver.clear('default');
  });
});
