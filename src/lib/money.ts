import Decimal from 'decimal.js';
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export const D = (v: Decimal.Value) => new Decimal(v);
export const round2 = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** Money as API/DB string with exactly 2 decimals. */
export const money = (v: Decimal.Value) => round2(v).toFixed(2);
