/** Indian digit grouping: 13046190 → "1,30,46,190"; decimals kept as given. */
export function formatIndian(value: number | string, decimals?: number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '';
  const fixed = decimals === undefined ? String(Math.abs(n)) : Math.abs(n).toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const s = intPart ?? '0';
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${n < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}
export const formatMoney = (value: number | string) => `₹${formatIndian(value, 2)}`;
