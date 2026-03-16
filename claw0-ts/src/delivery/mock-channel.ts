export class MockDeliveryChannel {
  sent: Array<{ to: string; text: string; time: number }> = [];

  constructor(
    public readonly name: string,
    private failRate = 0,
  ) {}

  setFailRate(rate: number): void {
    this.failRate = Math.max(0, Math.min(1, rate));
  }

  getFailRate(): number {
    return this.failRate;
  }

  async send(to: string, text: string): Promise<void> {
    if (Math.random() < this.failRate) {
      throw new Error(`[${this.name}] Simulated delivery failure to ${to}`);
    }

    this.sent.push({ to, text, time: Date.now() / 1000 });
    const preview = text.slice(0, 60).replace(/\n/g, " ");
    console.log(`  [delivery] [${this.name}] -> ${to}: ${preview}...`);
  }
}
