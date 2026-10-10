import { randomUUID } from 'node:crypto';
import { env } from '../../../config/env';
import { decrypt } from '../../../lib/crypto';
import { logger } from '../../../lib/logger';
import { getSetting } from '../../platform/settings.service';

export interface GatewaySetting { mode?: 'test' | 'live'; keyId?: string; keySecretEnc?: string | null; webhookSecretEnc?: string | null }
export interface Credentials { keyId: string; keySecret: string; webhookSecret: string; mode: string }

/** RZP-08: Settings (encrypted) first, env vars as fallback. */
export async function gatewayCredentials(): Promise<Credentials> {
  const s = await getSetting<GatewaySetting>('payment_gateway', {});
  const dec = (v: string | null | undefined) => {
    if (!v) return '';
    try {
      return decrypt(v);
    } catch (err) {
      logger.error({ err }, 'Could not decrypt a payment gateway secret (ENCRYPTION_KEY changed?)');
      return '';
    }
  };
  return {
    keyId: s.keyId || env.RAZORPAY_KEY_ID || '',
    keySecret: dec(s.keySecretEnc) || env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: dec(s.webhookSecretEnc) || env.RAZORPAY_WEBHOOK_SECRET || '',
    mode: s.mode ?? 'test',
  };
}

export interface RzpLinkPayment { payment_id: string; amount: number; status: string; method?: string; created_at?: number }
export interface RzpLink { id: string; short_url: string; status: string; amount: number; amount_paid?: number; notes?: Record<string, string>; payments?: RzpLinkPayment[] | null }
export interface RzpPayment { id: string; amount: number; status: string; method?: string; created_at: number; notes?: Record<string, string> | unknown[] }
export interface CreateLinkInput {
  amountPaise: number; referenceId: string; description: string;
  customer: { name: string; email?: string; contact?: string }; notes: Record<string, string>; expireBy: number;
}
export interface RazorpayDriver {
  configured(): Promise<boolean>;
  createLink(i: CreateLinkInput): Promise<RzpLink>;
  cancelLink(id: string): Promise<void>;
  fetchLink(id: string): Promise<RzpLink>;
  listPayments(fromUnix: number, toUnix: number): Promise<RzpPayment[]>;
  test(): Promise<void>;
}

class LiveDriver implements RazorpayDriver {
  async configured() {
    const c = await gatewayCredentials();
    return !!(c.keyId && c.keySecret);
  }
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const c = await gatewayCredentials();
    if (!c.keyId || !c.keySecret) throw new Error('Razorpay is not configured');
    const res = await fetch(`${env.RAZORPAY_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (!res.ok) throw new Error(`Razorpay ${method} ${path} → ${res.status} ${json.error?.description ?? ''}`.trim());
    return json;
  }
  createLink(i: CreateLinkInput) {
    return this.call<RzpLink>('POST', '/payment_links', {
      amount: i.amountPaise, currency: 'INR', accept_partial: false, reference_id: i.referenceId, description: i.description,
      customer: i.customer, notify: { sms: false, email: false }, reminder_enable: false, notes: i.notes, expire_by: i.expireBy,
    });
  }
  async cancelLink(id: string) {
    await this.call('POST', `/payment_links/${encodeURIComponent(id)}/cancel`);
  }
  fetchLink(id: string) {
    return this.call<RzpLink>('GET', `/payment_links/${encodeURIComponent(id)}`);
  }
  async listPayments(fromUnix: number, toUnix: number) {
    const out: RzpPayment[] = [];
    for (let skip = 0; skip < 5000; skip += 100) {
      const r = await this.call<{ items: RzpPayment[] }>('GET', `/payments?from=${fromUnix}&to=${toUnix}&count=100&skip=${skip}`);
      out.push(...r.items);
      if (r.items.length < 100) break;
    }
    return out;
  }
  async test() {
    await this.call('GET', '/payments?count=1');
  }
}

/** In-memory Razorpay for tests (RAZORPAY_DRIVER=fake). */
class FakeDriver implements RazorpayDriver {
  links = new Map<string, RzpLink>();
  payments: RzpPayment[] = [];
  async configured() {
    return true;
  }
  async createLink(i: CreateLinkInput) {
    const id = `plink_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const link: RzpLink = { id, short_url: `https://rzp.test/${id}`, status: 'created', amount: i.amountPaise, notes: i.notes, payments: [] };
    this.links.set(id, link);
    return link;
  }
  async cancelLink(id: string) {
    const l = this.links.get(id);
    if (l) l.status = 'cancelled';
  }
  async fetchLink(id: string) {
    const l = this.links.get(id);
    if (!l) throw new Error('link not found');
    return l;
  }
  async listPayments() {
    return this.payments;
  }
  async test() {
    /* always ok */
  }
  /** Test helper: pays a link; returns the payment and a webhook body for payment_link.paid. */
  pay(linkId: string, amountPaise?: number) {
    const l = this.links.get(linkId);
    if (!l) throw new Error('link not found');
    const p: RzpPayment = {
      id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`, amount: amountPaise ?? l.amount, status: 'captured', method: 'upi',
      created_at: Math.floor(Date.now() / 1000), notes: l.notes,
    };
    l.status = 'paid';
    l.payments = [{ payment_id: p.id, amount: p.amount, status: 'captured', method: 'upi', created_at: p.created_at }];
    this.payments.push(p);
    const body = {
      entity: 'event', event: 'payment_link.paid',
      payload: { payment_link: { entity: { ...l, amount_paid: p.amount } }, payment: { entity: p } },
    };
    return { payment: p, body };
  }
}

class OffDriver implements RazorpayDriver {
  async configured() {
    return false;
  }
  private no(): never {
    throw new Error('Razorpay driver is off');
  }
  async createLink(): Promise<RzpLink> { return this.no(); }
  async cancelLink(): Promise<void> { return this.no(); }
  async fetchLink(): Promise<RzpLink> { return this.no(); }
  async listPayments(): Promise<RzpPayment[]> { return this.no(); }
  async test(): Promise<void> { return this.no(); }
}

export const fakeRazorpay = new FakeDriver();
export const razorpay: RazorpayDriver =
  env.RAZORPAY_DRIVER === 'fake' ? fakeRazorpay : env.RAZORPAY_DRIVER === 'off' ? new OffDriver() : new LiveDriver();

/** Payment notes come back either as an object or as an empty array. */
export function notesOf(p: { notes?: Record<string, string> | unknown[] }): Record<string, string> {
  return p.notes && !Array.isArray(p.notes) ? p.notes : {};
}
