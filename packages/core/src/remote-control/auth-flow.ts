import { randomUUID } from "node:crypto";

export type RemoteAuthFlow = {
  id: string;
  server: string;
  authorizationUrl: string;
  createdAt: number;
  complete(callbackUrl: string): Promise<void>;
};

export type RemoteAuthFlowStoreOptions = {
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_AUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export class RemoteAuthFlowStore {
  private readonly flows = new Map<string, RemoteAuthFlow>();

  constructor(private readonly options: RemoteAuthFlowStoreOptions = {}) {}

  create(
    flow: Omit<RemoteAuthFlow, "id" | "createdAt">,
    id: string = randomUUID(),
  ): RemoteAuthFlow {
    this.pruneExpired();
    const created: RemoteAuthFlow = {
      id,
      createdAt: this.now(),
      ...flow,
    };
    this.flows.set(created.id, created);
    return { ...created };
  }

  get(id: string): RemoteAuthFlow | undefined {
    this.pruneExpired();
    const flow = this.flows.get(id);
    if (flow && this.isExpired(flow)) {
      this.flows.delete(id);
      return undefined;
    }
    return flow;
  }

  delete(id: string): void {
    this.flows.delete(id);
  }

  private pruneExpired(): void {
    for (const [id, flow] of this.flows) {
      if (this.isExpired(flow)) {
        this.flows.delete(id);
      }
    }
  }

  private isExpired(flow: RemoteAuthFlow): boolean {
    return this.now() - flow.createdAt > (this.options.ttlMs ?? DEFAULT_AUTH_FLOW_TTL_MS);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
