import { one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { financialYear, type ISODate } from '../../lib/dates';
import type { NumberingSettings } from './billing-config';

export type DocType = 'invoice' | 'credit_note' | 'receipt';

export const formatDocNumber = (prefix: string, fy: string, n: number) => `${prefix}/${fy}/${String(n).padStart(4, '0')}`;

/**
 * Next number for the FY of `date`. Call ONLY inside the transaction that inserts/updates the document.
 * The prefix is fixed per FY at its first number (a prefix change in Settings applies from the next FY).
 */
export async function nextDocNumber(tx: Tx, type: DocType, date: ISODate, numbering: NumberingSettings) {
  const fy = financialYear(date);
  const prefix = type === 'invoice' ? numbering.invoicePrefix : type === 'credit_note' ? numbering.creditNotePrefix : numbering.receiptPrefix;
  const r = await one<{ last_no: number; prefix: string }>(
    tx,
    `INSERT INTO app.doc_sequences (doc_type, fy, prefix, last_no) VALUES ($1, $2, $3, 1)
     ON CONFLICT (doc_type, fy) DO UPDATE SET last_no = app.doc_sequences.last_no + 1
     RETURNING last_no, prefix`,
    [type, fy, prefix],
  );
  return { number: formatDocNumber(r.prefix, fy, r.last_no), fy };
}
