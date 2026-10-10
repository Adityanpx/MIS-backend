import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { env, isTest } from '../../config/env';
import { logger } from '../../lib/logger';
import { getSetting } from '../platform/settings.service';

export interface OutgoingEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
}
export interface EmailDriver {
  send(message: OutgoingEmail): Promise<{ providerId: string }>;
}

/** Tests read sent emails (e.g. invite links) from here. */
export const testMailbox: OutgoingEmail[] = [];

class ConsoleEmailDriver implements EmailDriver {
  async send(m: OutgoingEmail) {
    if (isTest) testMailbox.push(m);
    // Development only: prints the text body so you can click invite/reset links. Never used in production (env.ts).
    else logger.info({ to: m.to, subject: m.subject, text: m.text }, 'EMAIL (console driver)');
    return { providerId: `console-${randomUUID()}` };
  }
}

class ResendEmailDriver implements EmailDriver {
  private readonly client = new Resend(env.RESEND_API_KEY);
  async send(m: OutgoingEmail) {
    const s = await getSetting<{ replyTo?: string; senderName?: string }>('email', {});
    const from = s.senderName ? `${s.senderName} <${env.EMAIL_FROM.replace(/^.*<|>.*$/g, '')}>` : env.EMAIL_FROM;
    const { data, error } = await this.client.emails.send({
      from, to: m.to, subject: m.subject, html: m.html, text: m.text, replyTo: s.replyTo || env.EMAIL_REPLY_TO || undefined,
    });
    if (error || !data) throw new Error(`Resend error: ${error?.message ?? 'no response'}`);
    return { providerId: data.id };
  }
}

export const emailDriver: EmailDriver = env.EMAIL_DRIVER === 'resend' ? new ResendEmailDriver() : new ConsoleEmailDriver();
