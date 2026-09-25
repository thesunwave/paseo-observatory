import { assertBackendAdapter } from "./contract.mjs";

export class BackendRegistry {
  constructor(adapters = []) {
    this.adapters = [];
    this.byId = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    const validated = assertBackendAdapter(adapter);
    if (this.byId.has(validated.id)) {
      throw new Error(`backend adapter ${validated.id} is already registered`);
    }
    this.adapters.push(validated);
    this.byId.set(validated.id, validated);
    return validated;
  }

  adapterFor(agent) {
    return this.adapters.find((adapter) => adapter.supports(agent)) ?? null;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  list() {
    return [...this.adapters];
  }

  close() {
    for (const adapter of this.adapters) adapter.close?.();
  }
}
