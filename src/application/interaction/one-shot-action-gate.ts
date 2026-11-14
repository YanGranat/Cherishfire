/** Synchronous gate for destructive/terminal handlers that must run once. */
export class OneShotActionGate {
  private claimed = false;

  claim(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }
}
