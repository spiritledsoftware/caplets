import { randomUUID } from "node:crypto";

export type RemoteAuthFlow = {
  id: string;
  server: string;
  authorizationUrl: string;
  createdAt: number;
  complete(callbackUrl: string): Promise<void>;
};

export class RemoteAuthFlowStore {
  private readonly flows = new Map<string, RemoteAuthFlow>();

  create(
    flow: Omit<RemoteAuthFlow, "id" | "createdAt">,
    id: string = randomUUID(),
  ): RemoteAuthFlow {
    const created: RemoteAuthFlow = {
      id,
      createdAt: Date.now(),
      ...flow,
    };
    this.flows.set(created.id, created);
    return created;
  }

  get(id: string): RemoteAuthFlow | undefined {
    return this.flows.get(id);
  }

  delete(id: string): void {
    this.flows.delete(id);
  }
}
