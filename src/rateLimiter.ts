export class RateLimiter {
  private connections: Map<string, number> = new Map();
  private maxConnections: number;
  constructor(maxConnections: number) {
    this.maxConnections = maxConnections;

    // Cleanup idle entries periodically
    setInterval(() => this.cleanup(), 60000);
  }

  checkConnection(ip: string): boolean {
    const count = this.connections.get(ip) ?? 0;

    if (count >= this.maxConnections) {
      return false;
    }

    this.connections.set(ip, count + 1);
    return true;
  }

  releaseConnection(ip: string): void {
    const count = this.connections.get(ip);
    if (count !== undefined && count > 0) {
      this.connections.set(ip, count - 1);
    }
  }

  private cleanup(): void {
    for (const [ip, count] of this.connections) {
      if (count <= 0) {
        this.connections.delete(ip);
      }
    }
  }
}
