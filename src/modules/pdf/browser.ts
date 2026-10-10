import type { Browser } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';
import { env, isProd } from '../../config/env';
import { logger } from '../../lib/logger';

let browser: Browser | null = null;
let used = 0;
let queue: Promise<unknown> = Promise.resolve();

async function executablePath(): Promise<string> {
  if (env.CHROME_EXECUTABLE_PATH) return env.CHROME_EXECUTABLE_PATH;
  if (isProd) return (await import('@sparticuz/chromium')).default.executablePath();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dev-only dependency
  return (require('puppeteer') as { executablePath: () => string }).executablePath();
}
async function getBrowser(): Promise<Browser> {
  if (browser && used < env.PDF_MAX_PER_BROWSER && browser.connected) return browser;
  if (browser) await browser.close().catch(() => undefined);
  const args = env.CHROME_EXECUTABLE_PATH
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none']
    : isProd ? (await import('@sparticuz/chromium')).default.args : ['--no-sandbox', '--disable-dev-shm-usage'];
  browser = await puppeteer.launch({ executablePath: await executablePath(), args, headless: true });
  used = 0;
  return browser;
}

export interface PdfOptions { format: 'A4' | 'A3'; landscape: boolean }
/** Renders HTML to PDF. Calls are serialised (one page at a time) to protect memory on the free tier. */
export function renderPdf(html: string, opts: PdfOptions): Promise<Buffer> {
  const run = async () => {
    const b = await getBrowser();
    used++;
    const page = await b.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      const pdf = await page.pdf({ format: opts.format, landscape: opts.landscape, printBackground: true, preferCSSPageSize: true });
      return Buffer.from(pdf);
    } catch (err) {
      logger.error({ err }, 'PDF render failed; restarting browser');
      await b.close().catch(() => undefined);
      browser = null;
      throw err;
    } finally {
      await page.close().catch(() => undefined);
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
/** PDF-01 test aid: counts pages (the MIS must be exactly 1). */
export const pdfPageCount = (buf: Buffer) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
export async function closeBrowser(): Promise<void> {
  if (browser) await browser.close().catch(() => undefined);
  browser = null;
}
