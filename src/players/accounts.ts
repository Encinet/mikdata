import type { Env } from '../env';
import { TtlMemoryCache } from '../shared/memory-cache';
import { asString } from '../shared/http';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(['default', 'member', 'moderator', 'custodian']);
export class PluginUnavailableError extends Error {}

export interface AccountRecord {
  playerUuid: string;
  currentName: string;
  role: string;
  disabledAt?: string;
  banned?: boolean;
  credentialsChangedAt?: number;
  policyCheckedAt?: number;
}

export function eligibleAccount(account: AccountRecord | undefined | null): account is AccountRecord {
  return !!account && !account.disabledAt && !account.banned && isEligibleRole(account.role);
}

export function eligibleMemberAccount(
  account: AccountRecord | undefined | null,
): account is AccountRecord {
  return eligibleAccount(account) && account.role !== 'default';
}

export function normalizePluginPlayer(
  raw: { uuid?: string; name?: string; role?: string } | undefined,
): { uuid: string; name: string } | null {
  const uuid = asString(raw?.uuid).trim().toLowerCase();
  const name = asString(raw?.name).trim();

  if (!UUID_RE.test(uuid) || !name || name.length > 64) {
    return null;
  }

  return { uuid, name };
}

export function normalizeRole(raw: unknown): string {
  const role = asString(raw).trim().toLowerCase();
  return ALLOWED_ROLES.has(role) ? role : '';
}

export function isEligibleRole(raw: unknown): boolean {
  return ALLOWED_ROLES.has(asString(raw));
}

export async function fetchPlayerPolicy(
  env: Env,
  playerUuid: string,
  currentName: string,
): Promise<{ role: string; credentialsChangedAt: number; banned: boolean }> {
  try {
    const response = await env.VPC_SERVICE.fetch(
      new URL(
        `/api/auth/accounts/${encodeURIComponent(playerUuid)}?name=${encodeURIComponent(currentName)}`,
        env.MINECRAFT_SERVER_URL,
      ),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new PluginUnavailableError();
    const payload = (await response.json()) as {
      player?: { uuid?: string; role?: string; credentialsChangedAt?: number; banned?: boolean };
    };
    if (
      payload.player?.uuid?.toLowerCase() !== playerUuid ||
      typeof payload.player.role !== 'string' ||
      typeof payload.player.banned !== 'boolean'
    )
      throw new PluginUnavailableError();
    const changed = payload.player.credentialsChangedAt;
    if (typeof changed !== 'number' || !Number.isSafeInteger(changed) || changed < 0)
      throw new PluginUnavailableError();
    return {
      role: payload.player.role.toLowerCase(),
      credentialsChangedAt: changed,
      banned: payload.player.banned,
    };
  } catch {
    throw new PluginUnavailableError();
  }
}

export async function fetchPlayer(env: Env, name: string): Promise<{ uuid: string; name: string } | null> {
  const path = `/api/players/resolve?name=${encodeURIComponent(name)}`;
  try {
    const response = await env.VPC_SERVICE.fetch(
      new URL(path, env.MINECRAFT_SERVER_URL),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { player?: { uuid?: string; name?: string } };
    const uuid = asString(payload.player?.uuid).toLowerCase();
    const currentName = asString(payload.player?.name);
    if (!UUID_RE.test(uuid) || !currentName) {
      return null;
    }
    return { uuid, name: currentName };
  } catch {
    return null;
  }
}

const lookupCaches = new WeakMap<Env, TtlMemoryCache<{ uuid: string; name: string }>>();
const policyReads = new WeakMap<Env, Map<string, Promise<AccountRecord | null>>>();

export function refreshPlayer(env: Env, uuid: string, read: () => Promise<AccountRecord | null>) {
  let pending = policyReads.get(env);
  if (!pending) policyReads.set(env, pending = new Map());
  let request = pending.get(uuid);
  if (!request) {
    request = read().finally(() => pending.delete(uuid));
    pending.set(uuid, request);
  }
  return request;
}

async function resolvePlayerName(env: Env, name: string) {
  let cache = lookupCaches.get(env);
  if (!cache) {
    cache = new TtlMemoryCache({ defaultTtlMs: 60_000, maxEntries: 1024 });
    lookupCaches.set(env, cache);
  }
  const cached = cache.get(name);
  if (cached) return cached;
  const player = await fetchPlayer(env, name);
  if (player) {
    cache.set(name, player);
    cache.set(player.name.trim().toLowerCase(), player);
  }
  return player;
}

function normalizePlayerName(value: string): string {
  const name = value.trim();
  return /^[a-zA-Z0-9_]{3,16}$/.test(name) ? name.toLowerCase() : '';
}

export async function lookupPlayer(env: Env, name: string) {
  const normalizedName = normalizePlayerName(name);
  if (!normalizedName) {
    return { status: 422, body: { error: 'invalid_name' } };
  }

  const player = await resolvePlayerName(env, normalizedName);
  if (!player) {
    return { status: 404, body: { error: 'player_not_found' } };
  }

  return {
    status: 200,
    body: {
      player: {
        uuid: player.uuid,
        name: player.name,
      },
    },
  };
}
