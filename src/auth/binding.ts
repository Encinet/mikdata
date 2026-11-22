import type { Env } from '../env';

const AUTH_STORE_NAME = 'global';

export interface StoreRequest {
  action: string;
  [key: string]: unknown;
}

export function authStore(env: Env): DurableObjectStub {
  const id = env.AUTH_STORE.idFromName(AUTH_STORE_NAME);
  return env.AUTH_STORE.get(id);
}
