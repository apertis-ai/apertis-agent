/**
 * A buffered multicast channel. The loop pushes events once; any number of
 * consumers (getText, getTextStream, getReasoningStream, ...) can each iterate
 * the full event sequence from the beginning, including replays of events that
 * were emitted before the consumer started.
 */

export class EventHub<T> {
  private buffer: T[] = [];
  private done = false;
  private failure: unknown;
  private waiters: Array<() => void> = [];

  push(event: T): void {
    this.buffer.push(event);
    this.wake();
  }

  finish(): void {
    this.done = true;
    this.wake();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Iterate every event from index 0. Throws if the producer failed. */
  async *stream(): AsyncGenerator<T> {
    let i = 0;
    while (true) {
      while (i < this.buffer.length) yield this.buffer[i++];
      if (this.done) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
