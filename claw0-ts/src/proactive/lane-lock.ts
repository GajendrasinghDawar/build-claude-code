function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LaneLock {
  private locked = false;

  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  async acquire(): Promise<void> {
    while (!this.tryAcquire()) {
      await sleep(50);
    }
  }

  release(): void {
    this.locked = false;
  }

  isLocked(): boolean {
    return this.locked;
  }
}
