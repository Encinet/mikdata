import { readSponsorCatalog, readSponsorOverview, type SponsorScope } from './queries';
import type { Env } from '../env';
import { canonicalContent, contentPrecondition, contentTag } from '../shared/content-precondition';
import { asString, json, serializedJson } from '../shared/http';
import { AFDIAN_FRESH_MS, type AfdianPayload } from './snapshot';
import { adminSponsorDetail, publicSponsors } from './catalog';
import { AFDIAN_ID_RE, formatAmount, minecraftUuid, parseManualOrder, parseManualOrderEdit, type ManualOrder, manualOrder, type OrderRow } from './model';

export class SponsorService {
  private readonly db: D1Database;

  constructor(private readonly env: Env) {
    this.db = env.DB;
  }

  async overview() {
    const { metadata, overview } = await readSponsorOverview(this.env);
    return json({ afdianStatus: afdianStatus(metadata), ...overview }, 200);
  }

  async catalog(scope: SponsorScope): Promise<Response> {
    const { players, pending, payload } = await readSponsorCatalog(this.env, scope);
    const status = afdianStatus(payload);
    if (scope.kind === 'public') {
      return serializedJson(JSON.stringify(publicSponsors(players.values())), 200, {
        'Cache-Control': 'public, no-cache',
        'X-Sponsor-Data': status === 'current' || status === 'disabled' ? 'complete' : status === 'stale' ? 'stale' : 'partial',
        'Access-Control-Expose-Headers': 'X-Sponsor-Data',
      });
    }
    const group = scope.kind === 'player' ? players.get(scope.id) : pending.get(scope.id);
    return group ? json(adminSponsorDetail(group), 200) : notFound();
  }

  private async order(id: string) {
    const row = await this.db.prepare('SELECT * FROM sponsor_orders WHERE id=?').bind(id).first<OrderRow>();
    return row ? manualOrder(row) : null;
  }

  async bindAccount(body: Record<string, unknown>) {
    const afdianUserId = asString(body.afdianUserId).trim();
    const uuid = minecraftUuid(body.uuid);
    if (!AFDIAN_ID_RE.test(afdianUserId) || !uuid) return invalid('an Afdian account and Minecraft UUID are required');
    await this.db.prepare('INSERT INTO sponsor_accounts VALUES (?,?) ON CONFLICT(afdian_id) DO UPDATE SET player_uuid=excluded.player_uuid').bind(afdianUserId, uuid).run();
    return changed();
  }

  async setName(uuid: string, body: Record<string, unknown>) {
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    if (name === undefined || name.length > 64) return invalid('name must be at most 64 characters');
    if (name) await this.db.prepare('INSERT INTO sponsor_names VALUES (?,?) ON CONFLICT(player_uuid) DO UPDATE SET name=excluded.name').bind(uuid, name).run();
    else await this.db.prepare('DELETE FROM sponsor_names WHERE player_uuid=?').bind(uuid).run();
    return changed();
  }

  async addOrder(key: string, uuid: string, body: Record<string, unknown>) {
    const order = parseManualOrder(body, uuid);
    if (!order || (body.uuid !== undefined && minecraftUuid(body.uuid) !== uuid)) return invalid('invalid manual order');
    const inserted = await this.db.prepare('INSERT INTO sponsor_orders VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(key, uuid, order.amountMinor, order.at, order.message ?? null).run();
    if (inserted.meta.changes) return changed();
    const existing = await this.order(key);
    return existing && sameOrder(existing, order) ? changed() : json({ error: 'that order already exists' }, 409);
  }

  async editManualOrder(key: string, owner: string, body: Record<string, unknown>): Promise<Response> {
    const edit = parseManualOrderEdit(body, owner);
    if (!edit) return invalid('invalid manual order edit');
    const { uuid, amount, time, message } = edit;
    // Test only fields the administrator saw and changed. Disjoint edits can commit together.
    const result = await this.db.prepare(`UPDATE sponsor_orders
      SET player_uuid=?, amount_minor=coalesce(?,amount_minor), paid_at=coalesce(?,paid_at),
          message=CASE WHEN ? THEN ? ELSE message END
      WHERE id=? AND player_uuid=?
        AND (? IS NULL OR amount_minor IN (?,?)) AND (? IS NULL OR paid_at IN (?,?))
        AND (? IS NULL OR coalesce(message,'') IN (?,?))`)
      .bind(uuid, amount?.to ?? null, time?.to ?? null, Number(!!message), message?.to || null, key, owner,
        amount?.from ?? null, amount?.from ?? null, amount?.to ?? null,
        time?.from ?? null, time?.from ?? null, time?.to ?? null,
        message?.from ?? null, message?.from ?? null, message?.to ?? null).run();
    if (result.meta.changes) return changed();
    const current = await this.order(key);
    if (!current) return notFound();
    if (current.uuid === uuid && (!amount || current.amountMinor === amount.to) &&
        (!time || current.at === time.to) && (!message || (current.message ?? '') === message.to)) return changed();
    return json({ error: 'that order has changed' }, 409);
  }

  async unbindAccount(id: string) {
    const result = await this.db.prepare('DELETE FROM sponsor_accounts WHERE afdian_id=?').bind(id).run();
    return result.meta.changes ? changed() : notFound();
  }

  async deleteOrder(uuid: string, orderUuid: string, ifMatch: string | null) {
    const expected = contentPrecondition(ifMatch);
    if ('status' in expected) return json(expected.body, expected.status);
    const key = orderUuid;
    const order = await this.order(key);
    if (!order || order.uuid !== uuid) return notFound();
    const content = canonicalContent({
      id: orderUuid, uuid, amount: formatAmount(order.amountMinor), at: order.at, message: order.message ?? '',
    });
    if (expected.tag !== await contentTag(content)) return orderChanged();
    const deleted = await this.db.prepare('DELETE FROM sponsor_orders WHERE id=? AND player_uuid=? AND amount_minor=? AND paid_at=? AND message IS ?')
      .bind(key, uuid, order.amountMinor, order.at, order.message ?? null).run();
    if (deleted.meta.changes) return changed();
    return await this.order(key) ? orderChanged() : notFound();
  }
}

function changed(): Response {
  return new Response(null, { status: 204 });
}

function sameOrder(a: ManualOrder, b: ManualOrder): boolean {
  return a.uuid === b.uuid && a.amountMinor === b.amountMinor && a.at === b.at && a.message === b.message;
}

function orderChanged(): Response {
  return json({ error: 'that order has changed' }, 412);
}

function afdianStatus(payload: Pick<AfdianPayload, 'fetchedAt' | 'ordersComplete'> | undefined) {
  if (!payload) return 'unavailable';
  if (payload.fetchedAt === 0) return 'disabled';
  if (!payload.ordersComplete) return 'partial';
  return Date.now() - payload.fetchedAt < AFDIAN_FRESH_MS ? 'current' : 'stale';
}

function notFound(): Response {
  return json({ error: 'not found' }, 404);
}

function invalid(message: string): Response {
  return json({ error: message }, 400);
}
