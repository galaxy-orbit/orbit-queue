import type { DynamicModule } from '@galaxy-stack/orbit-core';
import { QueueService, type QueueServiceOptions, MemoryQueueDriver, type QueueDriver } from './queue';

export const QUEUE_SERVICE = Symbol('QUEUE_SERVICE');
export const QUEUE_OPTIONS = Symbol('QUEUE_OPTIONS');

export class QueueModule {
  static forRoot(options: QueueServiceOptions = {}): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      providers: [
        { provide: QUEUE_OPTIONS, useValue: options },
        { provide: 'QUEUE_DRIVER', useFactory: () => options.driver ?? new MemoryQueueDriver() },
        {
          provide: QUEUE_SERVICE,
          useFactory: (opts: QueueServiceOptions, driver: QueueDriver) =>
            new QueueService({ ...opts, driver }),
          inject: [QUEUE_OPTIONS, 'QUEUE_DRIVER'],
        },
        { provide: QueueService, useExisting: QUEUE_SERVICE },
      ],
      exports: [QUEUE_SERVICE, QueueService, QUEUE_OPTIONS],
    };
  }

  static forRootAsync(options: {
    useFactory: (...args: any[]) => Promise<QueueServiceOptions> | QueueServiceOptions;
    inject?: any[];
  }): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      providers: [
        { provide: QUEUE_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        { provide: 'QUEUE_DRIVER', useFactory: (opts: QueueServiceOptions) => opts.driver ?? new MemoryQueueDriver(), inject: [QUEUE_OPTIONS] },
        {
          provide: QUEUE_SERVICE,
          useFactory: (opts: QueueServiceOptions, driver: QueueDriver) =>
            new QueueService({ ...opts, driver }),
          inject: [QUEUE_OPTIONS, 'QUEUE_DRIVER'],
        },
        { provide: QueueService, useExisting: QUEUE_SERVICE },
      ],
      exports: [QUEUE_SERVICE, QueueService, QUEUE_OPTIONS],
    };
  }
}

export { QueueService, MemoryQueueDriver };
export type { QueueServiceOptions } from './queue';
