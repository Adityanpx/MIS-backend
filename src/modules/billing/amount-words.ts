import { round2 } from '../../lib/money';

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function two(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  return n % 10 ? `${t} ${ONES[n % 10] ?? ''}` : t;
}
function three(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h] ?? ''} Hundred` : '', r ? two(r) : ''].filter(Boolean).join(' ');
}
/** 13046190 → "One Crore Thirty Lakh Forty Six Thousand One Hundred Ninety" */
export function inWordsIndian(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error('inWordsIndian: non-negative number required');
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${inWordsIndian(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return parts.join(' ');
}
/** "70800.00" → "Rupees Seventy Thousand Eight Hundred Only"; paise are added when present. */
export function rupeesInWords(amount: string): string {
  const d = round2(amount);
  const rupees = d.floor().toNumber();
  const paise = d.minus(d.floor()).mul(100).round().toNumber();
  return `Rupees ${inWordsIndian(rupees)}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}
