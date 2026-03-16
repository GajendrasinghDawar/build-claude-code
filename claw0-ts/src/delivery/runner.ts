import {
  DeliveryQueue,
  MAX_RETRIES,
  computeBackoffMs,
  type QueuedDelivery,
} from "./queue.js";

export class DeliveryRunner {
  private timer: NodeJS.Timeout | null = null;
  private stopRequested = false;

  totalAttempted = 0;
  totalSucceeded = 0;
  totalFailed = 0;

  constructor(
    private readonly queue: DeliveryQueue,
    private readonly deliverFn: (
      channel: string,
      to: string,
      text: string,
    ) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    await this.recoveryScan();
    if (this.timer) return;

    this.stopRequested = false;
    this.timer = setInterval(() => {
      void this.processPending();
    }, 1000);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async recoveryScan(): Promise<void> {
    const pending = await this.queue.loadPending();
    const failed = await this.queue.loadFailed();

    if (!pending.length && !failed.length) {
      console.log("  [delivery] Recovery: queue is clean");
      return;
    }

    const parts: string[] = [];
    if (pending.length) parts.push(`${pending.length} pending`);
    if (failed.length) parts.push(`${failed.length} failed`);
    console.log(`  [delivery] Recovery: ${parts.join(", ")}`);
  }

  private async processPending(): Promise<void> {
    if (this.stopRequested) return;

    const now = Date.now() / 1000;
    const pending = await this.queue.loadPending();

    for (const entry of pending) {
      if (this.stopRequested) break;
      if (entry.next_retry_at > now) continue;

      await this.processOne(entry);
    }
  }

  private async processOne(entry: QueuedDelivery): Promise<void> {
    this.totalAttempted += 1;

    try {
      await this.deliverFn(entry.channel, entry.to, entry.text);
      await this.queue.ack(entry.id);
      this.totalSucceeded += 1;
    } catch (error: unknown) {
      const err = error as { message?: string };
      const msg = err.message ?? "unknown delivery error";
      await this.queue.fail(entry.id, msg);
      this.totalFailed += 1;

      const retryInfo = `retry ${entry.retry_count + 1}/${MAX_RETRIES}`;
      if (entry.retry_count + 1 >= MAX_RETRIES) {
        console.log(
          `  [warn] Delivery ${entry.id.slice(0, 8)}... -> failed/ (${retryInfo}): ${msg}`,
        );
      } else {
        const backoff = computeBackoffMs(entry.retry_count + 1);
        console.log(
          `  [warn] Delivery ${entry.id.slice(0, 8)}... failed (${retryInfo}), next retry in ${Math.round(backoff / 1000)}s: ${msg}`,
        );
      }
    }
  }

  async getStats(): Promise<{
    pending: number;
    failed: number;
    total_attempted: number;
    total_succeeded: number;
    total_failed: number;
  }> {
    const pending = await this.queue.loadPending();
    const failed = await this.queue.loadFailed();

    return {
      pending: pending.length,
      failed: failed.length,
      total_attempted: this.totalAttempted,
      total_succeeded: this.totalSucceeded,
      total_failed: this.totalFailed,
    };
  }
}
