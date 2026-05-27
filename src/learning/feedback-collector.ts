export interface FeedbackEvent {
  query: string;
  passed: boolean;
  tokenCost: number;
  retries: number;
}

export class FeedbackCollector {
  private readonly events: FeedbackEvent[] = [];

  add(event: FeedbackEvent): void {
    this.events.push(event);
  }

  list(): FeedbackEvent[] {
    return [...this.events];
  }
}
