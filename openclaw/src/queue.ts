export class SessionCommandQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  enqueue<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionKey) ?? Promise.resolve();

    const next = previous
      .catch(() => {
        // preserve queue chain even if previous failed
      })
      .then(() => work());

    const finalized = next.finally(() => {
      if (this.chains.get(sessionKey) === finalized) {
        this.chains.delete(sessionKey);
      }
    });

    this.chains.set(sessionKey, finalized);
    return next;
  }
}
