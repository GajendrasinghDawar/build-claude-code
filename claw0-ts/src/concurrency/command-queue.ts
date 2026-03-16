export interface LaneStats {
  name: string;
  queueDepth: number;
  active: number;
  maxConcurrency: number;
  generation: number;
}

type QueueTask<T> = {
  fn: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  generation: number;
};

export class LaneQueue {
  readonly name: string;

  private queue: QueueTask<any>[] = [];
  private activeCount = 0;
  private currentGeneration = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    name: string,
    private max = 1,
  ) {
    this.name = name;
    this.max = Math.max(1, max);
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get maxConcurrency(): number {
    return this.max;
  }

  setMaxConcurrency(value: number): void {
    this.max = Math.max(1, value);
    this.pump();
  }

  incrementGeneration(): number {
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  enqueue<T>(fn: () => Promise<T> | T, generation?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn,
        resolve,
        reject,
        generation: generation ?? this.currentGeneration,
      });
      this.pump();
    });
  }

  stats(): LaneStats {
    return {
      name: this.name,
      queueDepth: this.queue.length,
      active: this.activeCount,
      maxConcurrency: this.max,
      generation: this.currentGeneration,
    };
  }

  isIdle(): boolean {
    return this.activeCount === 0 && this.queue.length === 0;
  }

  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    if (this.isIdle()) return true;

    return new Promise<boolean>((resolve) => {
      let done = false;

      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(ok);
      };

      const waiter = () => finish(true);
      this.idleWaiters.push(waiter);

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.idleWaiters = this.idleWaiters.filter((w) => w !== waiter);
              finish(false);
            }, timeoutMs)
          : null;
    });
  }

  private notifyIdleWaiters(): void {
    if (!this.isIdle()) return;
    if (!this.idleWaiters.length) return;

    const waiters = [...this.idleWaiters];
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private pump(): void {
    while (this.activeCount < this.max && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) return;

      this.activeCount += 1;
      void Promise.resolve()
        .then(() => task.fn())
        .then((value) => {
          task.resolve(value);
        })
        .catch((error) => {
          task.reject(error);
        })
        .finally(() => {
          this.taskDone(task.generation);
        });
    }
  }

  private taskDone(generation: number): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (generation === this.currentGeneration) {
      this.pump();
    }
    this.notifyIdleWaiters();
  }
}

export class CommandQueue {
  private readonly lanes = new Map<string, LaneQueue>();

  getOrCreateLane(name: string, maxConcurrency = 1): LaneQueue {
    const existing = this.lanes.get(name);
    if (existing) return existing;

    const lane = new LaneQueue(name, maxConcurrency);
    this.lanes.set(name, lane);
    return lane;
  }

  enqueue<T>(laneName: string, fn: () => Promise<T> | T): Promise<T> {
    return this.getOrCreateLane(laneName).enqueue(fn);
  }

  setLaneConcurrency(
    laneName: string,
    maxConcurrency: number,
  ): {
    oldValue: number;
    newValue: number;
  } {
    const lane = this.getOrCreateLane(laneName);
    const oldValue = lane.maxConcurrency;
    lane.setMaxConcurrency(maxConcurrency);
    return { oldValue, newValue: lane.maxConcurrency };
  }

  resetAll(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, lane] of this.lanes.entries()) {
      result[name] = lane.incrementGeneration();
    }
    return result;
  }

  async waitForAll(timeoutMs = 10_000): Promise<boolean> {
    const started = Date.now();
    const lanes = [...this.lanes.values()];

    for (const lane of lanes) {
      const elapsed = Date.now() - started;
      const remaining = Math.max(0, timeoutMs - elapsed);
      if (!(await lane.waitForIdle(remaining))) {
        return false;
      }
    }

    return true;
  }

  stats(): Record<string, LaneStats> {
    const out: Record<string, LaneStats> = {};
    for (const [name, lane] of this.lanes.entries()) {
      out[name] = lane.stats();
    }
    return out;
  }

  laneNames(): string[] {
    return [...this.lanes.keys()];
  }
}
