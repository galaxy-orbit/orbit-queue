import type { Job, QueueDriver } from '../queue';

/**
 * Redis-backed queue driver using Bun's native Redis client (zero dependencies).
 *
 * Jobs live in a sorted set per queue: ZSET key `prefix:queue` scored by runAt.
 * Claims are atomic via an EVAL script (ZRANGEBYSCORE + ZREM) so multiple
 * workers never receive the same job.
 */
export interface RedisDriverOptions {
  /** Redis connection URL. Default: redis://localhost:6379 */
  url?: string;
  /** Key prefix. Default: 'orbit:queue' */
  prefix?: string;
}

const CLAIM_SCRIPT =
  "local j = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1); " +
  'if #j > 0 then redis.call(\'ZREM\', KEYS[1], j[1]); return j[1]; end return false';

export class RedisQueueDriver implements QueueDriver {
  private redis: any;
  private prefix: string;
  private ownsClient = false;

  constructor(options: RedisDriverOptions = {}) {
    this.prefix = options.prefix ?? 'orbit:queue';
    if (options.url) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RedisClient } = require('bun');
      this.redis = new RedisClient(options.url);
      this.ownsClient = true;
    } else {
      this.redis = (globalThis as any).Bun.redis;
    }
  }

  private key(queue: string): string {
    return `${this.prefix}:${queue}`;
  }

  async add(job: Job): Promise<void> {
    await this.redis.zadd(this.key(job.queue), job.runAt, JSON.stringify(job));
  }

  async claim(queue = 'default'): Promise<Job | null> {
    const member = await this.redis.send('EVAL', [
      CLAIM_SCRIPT,
      '1',
      this.key(queue),
      String(Date.now()),
    ]);
    if (!member || member === false) return null;
    return JSON.parse(member as string) as Job;
  }

  async requeue(job: Job, delayMs: number): Promise<void> {
    const updated = { ...job, runAt: Date.now() + delayMs };
    await this.redis.zadd(this.key(job.queue), updated.runAt, JSON.stringify(updated));
  }

  async complete(_job: Job): Promise<void> {
    // job was removed from the ZSET on claim — nothing to do
  }

  /** Pending (due) job count for a queue. */
  async count(queue = 'default'): Promise<number> {
    return Number(await this.redis.zcount(this.key(queue), '-inf', String(Date.now())));
  }

  /** Total jobs including future-scheduled ones. */
  async countAll(queue = 'default'): Promise<number> {
    return Number(await this.redis.zcount(this.key(queue), '-inf', '+inf'));
  }

  /** Remove all jobs in a queue (testing utility). */
  async clear(queue = 'default'): Promise<void> {
    await this.redis.del(this.key(queue));
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.redis?.close) {
      await this.redis.close();
    }
  }
}
