import ExcelJS from 'exceljs';
import { exec } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { addDays } from '../../lib/dates';
import { dayValue } from '../engine/core/derive';
import { getBundle } from '../engine/engine.service';
import { storage, tenantKey } from '../files/storage';
import { sendInBackground } from '../notifications/email.service';
import { notify, plantRecipients } from '../notifications/notify.service';

/** One row per date: every parameter, stock balances, cash, absent staff, revenue STD/ACT (EXP-04). */
export async function logsheetWorkbookBuffer(tenantId: string, plantId: string, from: string, to: string): Promise<Buffer> {
  const b = await getBundle(tenantId, plantId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Logsheets');
  const params = b.settings.params.filter((p) => p.aggregation !== 'stock');
  ws.addRow(['Date', 'Status', ...params.map((p) => `${p.code} (${p.unit})`), ...b.settings.stock.map((i) => `${i.code}_BALANCE`),
    'CASH_IN_HAND', ...b.settings.staff.map((c) => `STAFF_${c.code}_ABSENT`), 'REV_STD', 'REV_ACT']).font = { bold: true };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const rec = b.data.days.get(d);
    const dd = b.derived.get(d);
    ws.addRow([d, rec?.status ?? 'missing',
      ...params.map((p) => (p.aggregation === 'text' ? (rec?.values[p.code] as string | null) ?? null : dayValue(b.data, b.derived, p.code, d))),
      ...b.settings.stock.map((i) => dd?.stock[i.code] ?? null), dd?.cash ?? null,
      ...b.settings.staff.map((c) => dd?.absent[c.code] ?? null), dd?.revStd ?? null, dd?.revAct ?? null]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

registerHandler(QUEUES.exportLogsheets, async (data) => {
  const { tenantId, plantId, from, to, exportId, userId } = data as { tenantId: string; plantId: string; from: string; to: string; exportId: string; userId: string };
  const ctx = { tenantId, actorId: null };
  try {
    const key = tenantKey(tenantId, 'exports', `${exportId}.xlsx`);
    await storage.put(key, await logsheetWorkbookBuffer(tenantId, plantId, from, to), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const outbox = await withTenant(ctx, async (tx) => {
      await exec(tx, `UPDATE app.exports SET status = 'ready', file_key = $3, expires_at = now() + interval '7 days' WHERE tenant_id = $1 AND id = $2`,
        [tenantId, exportId, key]);
      const recipients = (await plantRecipients(tx, tenantId, plantId, ['client_admin', 'editor', 'checker', 'verifier', 'viewer'])).filter((u) => u.id === userId);
      return notify(tx, { tenantId, to: recipients, code: 'N-O08', title: `Logsheet export ${from} to ${to} is ready`, body: 'Download within 7 days.',
        link: `/exports/${exportId}`, email: true });
    });
    sendInBackground(outbox);
  } catch (err) {
    await withTenant(ctx, (tx) => exec(tx, `UPDATE app.exports SET status = 'failed', error = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, exportId, String((err as Error).message).slice(0, 300)]));
    throw err;
  }
});
