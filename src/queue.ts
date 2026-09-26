export interface Job<T = any> {
  id: string;
  queue: string;
  name: string;
  data: T;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  runAt: number;
}

export interface QueueDriver {
  add(job: Job): Promise<void>;
  /** Claim the next due job. Returns null when empty. */
  claim(queue?: string): Promise<Job | null>;
  /** Release a claimed job back into the queue with a delay (retry). */
  requeue(job: Job, delayMs: number): Promise<void>;
  /** Drop the job (done or dead-lettered). */
  complete(job: Job): Promise<void>;
  count(queue?: string): Promise<number>;
}

export interface JobHandler {
  process(job: Job): Promise<void> | void;
  onFailed?: (job: Job, error: Error) => void;
  maxAttempts?: number;
}

export class MemoryQueueDriver implements QueueDriver {
  private jobs: Job[] = [];
  private seq = 0;

  newId(): string {
    return `job_${++this.seq}_${Math.random().toString(36).slice(2, 7)}`;
  }

  async add(job: Job): Promise<void> {
    this.jobs.push(job);
  }

  async claim(queue?: string): Promise<Job | null> {
    const now = Date.now();
    const idx = this.jobs.findIndex((j) => j.runAt <= now && (!queue || j.queue === queue));
    if (idx === -1) return null;
    const [job] = this.jobs.splice(idx, 1);
    return job;
  }

  async requeue(job: Job, delayMs: number): Promise<void> {
    this.jobs.push({ ...job, runAt: Date.now() + delayMs });
  }

  async complete(_job: Job): Promise<void> {
    // claimed jobs are already removed
  }

  async count(queue?: string): Promise<number> {
    return this.jobs.filter((j) => !queue || j.queue === queue).length;
  }
}

export interface QueueServiceOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  /** Base retry delay in ms — doubles per attempt. Default: 1000 */
  retryDelayMs?: number;
  /** Pre-built driver instance. */
  driver?: QueueDriver;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class QueueService {
  private driver: QueueDriver;
  private handlers = new Map<string, JobHandler>();
  private running = false;
  private concurrency: number;
  private pollIntervalMs: number;
  private retryDelayMs: number;

  constructor(options: QueueServiceOptions = {}) {
    this.driver = options.driver ?? new MemoryQueueDriver();
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.retryDelayMs = options.retryDelayMs ?? 50;
  }

  /** Register a handler for jobs named `name` in `queue` (default queue: 'default'). */
  register(name: string, handler: JobHandler, queue = 'default'): void {
    this.handlers.set(`${queue}:${name}`, handler);
    this.queues.add(queue);
  }

  async add<T = any>(
    name: string,
    data: T,
    options: { queue?: string; delayMs?: number; maxAttempts?: number; jobId?: string } = {}
  ): Promise<Job<T>> {
    const queue = options.queue ?? 'default';
    const driver = this.driver as any;
    const job: Job<T> = {
      id: typeof driver.newId === 'function' ? driver.newId() : `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      queue,
      name,
      data,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      createdAt: Date.now(),
      runAt: Date.now() + (options.delayMs ?? 0),
    };
    await this.driver.add(job);
    return job;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async count(queue = 'default'): Promise<number> {
    return this.driver.count(queue);
  }

  private queues = new Set<string>();

  private async loop(): Promise<void> {
    while (this.running) {
      let worked = false;
      for (const queue of this.queues) {
        while (this.activeCount < this.concurrency) {
          const job = await this.driver.claim(queue);
          if (!job) break;
          const handler = this.handlers.get(`${queue}:${job.name}`);
          if (!handler) {
            // no handler for this job name — park it so it does not starve others
            await this.driver.requeue(job, 1000);
            continue;
          }
          worked = true;
          this.activeCount++;
          void this.run(job, handler);
        }
        if (this.activeCount >= this.concurrency) break;
      }
      if (!worked) await sleep(this.pollIntervalMs);
    }
  }

  private activeCount = 0;

  private async run(job: Job, handler: JobHandler): Promise<void> {
    job.attempts++;
    try {
      await handler.process(job);
      await this.driver.complete(job);
    } catch (error) {
      if (job.attempts < (handler.maxAttempts ?? 3)) {
        await this.driver.requeue(job, this.retryDelayMs * Math.pow(2, job.attempts - 1));
      } else {
        handler.onFailed?.(job, error as Error);
        await this.driver.complete(job);
      }
    } finally {
      this.activeCount--;
    }
  }

  async processOnce(queue = 'default'): Promise<boolean> {
    for (const [key, handler] of this.handlers) {
      const [q, name] = key.split(':');
      if (q !== queue) continue;
      const job = await this.driver.claim(q);
      if (!job) continue;
      const jobHandler = this.handlers.get(`${q}:${job.name}`);
      if (!jobHandler) {
        // no handler for this job name — park it
        await this.driver.requeue(job, 1000);
        continue;
      }
      if (job.name !== name) {
        // belongs to another registered handler in this queue — run via its own handler
        job.attempts++;
        try {
          await jobHandler.process(job);
          await this.driver.complete(job);
        } catch (error) {
          if (job.attempts < (jobHandler.maxAttempts ?? 3)) {
            await this.driver.requeue(job, this.retryDelayMs * Math.pow(2, job.attempts - 1));
          } else {
            jobHandler.onFailed?.(job, error as Error);
            await this.driver.complete(job);
          }
        }
        return true;
      }
      job.attempts++;
      try {
        await handler.process(job);
        await this.driver.complete(job);
      } catch (error) {
        if (job.attempts < (handler.maxAttempts ?? 3)) {
          await this.driver.requeue(job, this.retryDelayMs * Math.pow(2, job.attempts - 1));
        } else {
          handler.onFailed?.(job, error as Error);
          await this.driver.complete(job);
        }
      }
      return true;
    }
    return false;
  }
}
