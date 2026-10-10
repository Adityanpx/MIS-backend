import crypto from 'node:crypto';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { exec } from '../../../db/sql';
import { withSystem } from '../../../db/tenant';
import { safeEqual, sha256 } from '../../../lib/crypto';
import { AppError, badRequest } from '../../../lib/errors';
import { asyncHandler } from '../../../lib/http';
import { logger } from '../../../lib/logger';
import { isTest } from '../../../config/env';
import { sendInBackground } from '../../notifications/email.service';
import { notifySuperAdmins } from '../billing-notify';
import { gatewayCredentials, notesOf, type RzpLink, type RzpPayment } from './gateway';
import { processCapturedPayment } from './process';

interface RzpEvent {
  event: string;
  payload: { payment_link?: { entity: RzpLink }; payment?: { entity: RzpPayment }; refund?: { entity: { id: string; amount: number; payment_id: string } } };
}

const webhookLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => isTest });

async function handle(event: RzpEvent): Promise<string> {
  if (event.event === 'payment_link.paid') {
    const link = event.payload.payment_link?.entity;
    const pay = event.payload.payment?.entity;
    const notes = link ? notesOf(link as { notes?: Record<string, string> }) : {};
    if (!pay || !notes.tenantId || !notes.invoiceId) return 'ignored:no-notes';
    const r = await processCapturedPayment({
      rzpPaymentId: pay.id, amountPaise: pay.amount, tenantId: notes.tenantId, invoiceId: notes.invoiceId,
      method: pay.method, paidAtUnix: pay.created_at, source: 'razorpay',
    });
    return r.status;
  }
  if (event.event === 'payment.captured') {
    const pay = event.payload.payment?.entity;
    const notes = pay ? notesOf(pay) : {};
    if (!pay || !notes.tenantId || !notes.invoiceId) return 'ignored:not-ours'; // link payments arrive as payment_link.paid
    const r = await processCapturedPayment({
      rzpPaymentId: pay.id, amountPaise: pay.amount, tenantId: notes.tenantId, invoiceId: notes.invoiceId,
      method: pay.method, paidAtUnix: pay.created_at, source: 'razorpay',
    });
    return r.status;
  }
  if (event.event === 'payment.failed') return 'logged';
  if (event.event === 'refund.processed') {
    const refund = event.payload.refund?.entity;
    const outbox = await withSystem((tx) => notifySuperAdmins(tx, {
      code: 'N-S03', title: 'Refund processed in Razorpay', body: `Refund ${refund?.id ?? ''} for payment ${refund?.payment_id ?? ''}. Record it against the client (credit refund).`,
      dedupeKey: `N-S03:refund:${refund?.id ?? ''}`, email: true,
    }));
    sendInBackground(outbox);
    return 'flagged';
  }
  return 'ignored';
}

export const webhooksRouter = Router();
webhooksRouter.post(
  '/razorpay',
  webhookLimiter,
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const raw = req.body as unknown;
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw badRequest('INVALID_BODY', 'Empty body');
    const { webhookSecret } = await gatewayCredentials();
    if (!webhookSecret) throw new AppError('WEBHOOK_NOT_CONFIGURED', 503, 'Webhook secret is not configured');
    const expected = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    if (!safeEqual(req.header('x-razorpay-signature') ?? '', expected)) {
      logger.warn({ requestId: req.requestId }, 'Razorpay webhook with an invalid signature');
      throw badRequest('WEBHOOK_SIGNATURE_INVALID', 'Invalid signature');
    }
    let event: RzpEvent;
    try {
      event = JSON.parse(raw.toString('utf8')) as RzpEvent;
    } catch {
      throw badRequest('INVALID_JSON', 'Body is not JSON');
    }
    const eventId = req.header('x-razorpay-event-id') || sha256(raw.toString('utf8'));
    const isNew = await withSystem(async (tx) => {
      const r = await tx.query(
        `INSERT INTO app.razorpay_events (event_id, event_type, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, String(event.event ?? 'unknown'), raw.toString('utf8')],
      );
      return (r.rowCount ?? 0) > 0;
    });
    if (!isNew) return res.status(200).json({ ok: true, duplicate: true });
    try {
      const result = await handle(event);
      await withSystem((tx) => exec(tx, 'UPDATE app.razorpay_events SET processed_at = now(), result = $2 WHERE event_id = $1', [eventId, result]));
    } catch (err) {
      logger.error({ err, eventId }, 'Razorpay webhook processing failed');
      await withSystem(async (tx) => {
        await exec(tx, 'UPDATE app.razorpay_events SET error = $2 WHERE event_id = $1', [eventId, String((err as Error).message).slice(0, 500)]);
        return notifySuperAdmins(tx, {
          code: 'N-S06', title: 'Razorpay webhook processing failed', body: `Event ${eventId}: ${String((err as Error).message).slice(0, 200)}`,
          dedupeKey: `N-S06:webhook:${eventId}`, email: true,
        });
      }).then(sendInBackground).catch(() => undefined);
    }
    res.status(200).json({ ok: true });
  }),
);
