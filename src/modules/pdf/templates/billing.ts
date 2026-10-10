import QRCode from 'qrcode';
import { formatIndian } from '../../../shared/format';
import { rupeesInWords } from '../../billing/amount-words';
import { BASE_CSS, dt, esc } from './html';

const m = (v: string | number | null | undefined) => (v === null || v === undefined ? '–' : formatIndian(v, 2));

export interface PartyBlock {
  legalName: string; tradeName?: string; gstin?: string | null; pan?: string | null; cin?: string; stateCode?: string;
  stateName?: string; email?: string; phone?: string;
  address?: { line1?: string; line2?: string; city?: string; pin?: string };
}
export interface SellerBlock extends PartyBlock {
  bank: { accountName: string; accountNo: string; ifsc: string; branch: string };
  upiId: string; signatory: { name: string; designation: string }; footerTerms: string; sac: string;
}

function addr(a?: PartyBlock['address']) {
  return a ? [a.line1, a.line2, a.city, a.pin].filter(Boolean).map((x) => esc(x)).join(', ') : '';
}
function sellerHead(s: SellerBlock, logoUrl: string | null, title: string, right: string) {
  return `<div class="head"><div class="seller">${logoUrl ? `<img src="${esc(logoUrl)}" class="logo">` : ''}
      <div><b class="big">${esc(s.legalName)}</b>${s.tradeName ? `<br>${esc(s.tradeName)}` : ''}<br>${addr(s.address)}
      <br>GSTIN ${esc(s.gstin ?? '')} · PAN ${esc(s.pan ?? '')}${s.cin ? ` · CIN ${esc(s.cin)}` : ''}
      <br>${esc(s.email ?? '')}${s.phone ? ` · ${esc(s.phone)}` : ''}</div></div>
    <div class="doc"><div class="title">${esc(title)}</div>${right}</div></div>`;
}
function buyerBlock(b: PartyBlock, placeOfSupply: string | null) {
  return `<div class="box"><b>Bill to</b><br><b>${esc(b.legalName)}</b><br>${addr(b.address)}
    <br>GSTIN ${esc(b.gstin ?? 'Unregistered')} · State ${esc(b.stateName ?? '')} (${esc(b.stateCode ?? '')})
    ${placeOfSupply ? `<br>Place of supply: ${esc(placeOfSupply)}` : ''}</div>`;
}
function signBlock(s: SellerBlock) {
  return `<div class="sign">For <b>${esc(s.legalName)}</b><br><br><br>${esc(s.signatory.name)}<br>${esc(s.signatory.designation)}
    <br><span class="muted">Authorised Signatory</span></div>`;
}
const CSS = `${BASE_CSS} @page { size: A4 portrait; margin: 10mm; } body { font-size: 10px; }
  .head { display: flex; justify-content: space-between; border-bottom: 2px solid #1f3864; padding-bottom: 6px; }
  .seller { display: flex; gap: 8px; } .logo { height: 46px; } .big { font-size: 13px; }
  .doc { text-align: right; } .title { font-size: 16px; font-weight: 700; color: #1f3864; margin-bottom: 4px; }
  .box { border: 1px solid #999; padding: 6px; margin: 8px 0; } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .tot td { border: none; padding: 1px 4px; } .tot .k { text-align: right; } .tot .v { text-align: right; width: 110px; }
  .grand td { font-weight: 700; font-size: 12px; border-top: 1px solid #333; }
  .sign { text-align: right; margin-top: 18px; } .pay { display: flex; gap: 10px; align-items: center; }
  .stamp { position: fixed; top: 40%; left: 20%; font-size: 64px; color: rgba(200,0,0,.18); transform: rotate(-25deg); font-weight: 800; }`;

export interface InvoiceDocData {
  number: string; issueDate: string; dueDate: string; status: string; placeOfSupply: string | null; gstType: string | null;
  gstRatePct: number; taxable: string; cgst: string; sgst: string; igst: string; roundOff: string; total: string;
  creditApplied: string; paid: string; tds: string; creditNoted: string; balance: string; notes: string | null;
  payUrl: string | null; seller: SellerBlock; buyer: PartyBlock;
  lines: Array<{ description: string; sac: string | null; qty: string; rate: string; taxable: string }>;
}
export async function invoiceHtml(d: InvoiceDocData, logoUrl: string | null): Promise<string> {
  const half = d.gstRatePct / 2;
  const qr = d.payUrl && Number(d.balance) > 0 ? await QRCode.toString(d.payUrl, { type: 'svg', margin: 0, width: 96 }) : '';
  const rows = d.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td>${esc(l.sac ?? d.seller.sac)}</td>
      <td class="num">${esc(Number(l.qty))}</td><td class="num">${m(l.rate)}</td><td class="num">${m(l.taxable)}</td></tr>`).join('');
  const taxRows = d.gstType === 'intra'
    ? `<tr><td class="k">CGST ${half}%</td><td class="v">${m(d.cgst)}</td></tr><tr><td class="k">SGST ${half}%</td><td class="v">${m(d.sgst)}</td></tr>`
    : `<tr><td class="k">IGST ${d.gstRatePct}%</td><td class="v">${m(d.igst)}</td></tr>`;
  const settle = [
    Number(d.creditApplied) > 0 ? `<tr><td class="k">Advance adjusted</td><td class="v">- ${m(d.creditApplied)}</td></tr>` : '',
    Number(d.paid) > 0 ? `<tr><td class="k">Amount paid</td><td class="v">- ${m(d.paid)}</td></tr>` : '',
    Number(d.tds) > 0 ? `<tr><td class="k">TDS</td><td class="v">- ${m(d.tds)}</td></tr>` : '',
    Number(d.creditNoted) > 0 ? `<tr><td class="k">Credit notes</td><td class="v">- ${m(d.creditNoted)}</td></tr>` : '',
  ].join('');
  const s = d.seller;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    ${d.status === 'cancelled' ? '<div class="stamp">CANCELLED</div>' : ''}
    ${sellerHead(s, logoUrl, 'TAX INVOICE', `Invoice No: <b>${esc(d.number)}</b><br>Date: ${dt(d.issueDate)}<br>Due: <b>${dt(d.dueDate)}</b>`)}
    ${buyerBlock(d.buyer, d.placeOfSupply)}
    <table><tr><th>#</th><th>Description</th><th>SAC</th><th>Qty</th><th>Rate (₹)</th><th>Amount (₹)</th></tr>${rows}</table>
    <div class="grid"><div class="box"><b>Amount in words</b><br>${esc(rupeesInWords(d.total))}
        ${d.notes ? `<br><br><b>Notes</b><br>${esc(d.notes)}` : ''}</div>
      <table class="tot"><tr><td class="k">Taxable value</td><td class="v">${m(d.taxable)}</td></tr>${taxRows}
        <tr><td class="k">Round off</td><td class="v">${m(d.roundOff)}</td></tr>
        <tr class="grand"><td class="k">TOTAL ₹</td><td class="v">${m(d.total)}</td></tr>${settle}
        <tr class="grand"><td class="k">Balance due ₹</td><td class="v">${m(d.balance)}</td></tr></table></div>
    <div class="box pay">${qr ? `<div>${qr}</div>` : ''}<div>${d.payUrl && Number(d.balance) > 0
      ? `<b>Pay online:</b> <a href="${esc(d.payUrl)}">${esc(d.payUrl)}</a><br>` : ''}
      <b>Bank transfer:</b> ${esc(s.bank.accountName)} · A/c ${esc(s.bank.accountNo)} · IFSC ${esc(s.bank.ifsc)} · ${esc(s.bank.branch)}
      ${s.upiId ? `<br><b>UPI:</b> ${esc(s.upiId)}` : ''}<br><span class="muted">Please quote the invoice number in the payment reference.</span></div></div>
    ${s.footerTerms ? `<div class="muted">${esc(s.footerTerms)}</div>` : ''}
    ${signBlock(s)}</body></html>`;
}

export interface CreditNoteDocData {
  number: string; date: string; invoiceNumber: string; invoiceDate: string; reason: string; gstType: string | null; gstRatePct: number;
  taxable: string; cgst: string; sgst: string; igst: string; total: string; placeOfSupply: string | null;
  seller: SellerBlock; buyer: PartyBlock;
}
export function creditNoteHtml(d: CreditNoteDocData, logoUrl: string | null): string {
  const half = d.gstRatePct / 2;
  const tax = d.gstType === 'intra'
    ? `<tr><td class="k">CGST ${half}%</td><td class="v">${m(d.cgst)}</td></tr><tr><td class="k">SGST ${half}%</td><td class="v">${m(d.sgst)}</td></tr>`
    : `<tr><td class="k">IGST ${d.gstRatePct}%</td><td class="v">${m(d.igst)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    ${sellerHead(d.seller, logoUrl, 'CREDIT NOTE', `No: <b>${esc(d.number)}</b><br>Date: ${dt(d.date)}<br>Against invoice ${esc(d.invoiceNumber)} dated ${dt(d.invoiceDate)}`)}
    ${buyerBlock(d.buyer, d.placeOfSupply)}
    <div class="box"><b>Reason:</b> ${esc(d.reason)}</div>
    <div class="grid"><div class="box"><b>Amount in words</b><br>${esc(rupeesInWords(d.total))}</div>
      <table class="tot"><tr><td class="k">Taxable value</td><td class="v">${m(d.taxable)}</td></tr>${tax}
        <tr class="grand"><td class="k">TOTAL ₹</td><td class="v">${m(d.total)}</td></tr></table></div>
    ${signBlock(d.seller)}</body></html>`;
}

export interface ReceiptDocData {
  number: string; date: string; paymentDate: string; mode: string; reference: string | null; bank: string | null; amount: string;
  gatewayFee: string; toCredit: string; seller: SellerBlock; buyer: PartyBlock;
  allocations: Array<{ invoiceNumber: string | null; amount: string }>;
}
export function receiptHtml(d: ReceiptDocData, logoUrl: string | null): string {
  const rows = d.allocations.map((a) => `<tr><td>${esc(a.invoiceNumber ?? 'Credit balance')}</td><td class="num">${m(a.amount)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    ${sellerHead(d.seller, logoUrl, 'PAYMENT RECEIPT', `No: <b>${esc(d.number)}</b><br>Date: ${dt(d.date)}`)}
    <div class="box">Received with thanks from <b>${esc(d.buyer.legalName)}</b> the sum of <b>₹${m(d.amount)}</b>
      (${esc(rupeesInWords(d.amount))}) by <b>${esc(d.mode.toUpperCase())}</b>${d.reference ? ` (ref. ${esc(d.reference)})` : ''}
      ${d.bank ? `, ${esc(d.bank)}` : ''} on ${dt(d.paymentDate)}.</div>
    <table><tr><th>Settled against</th><th>Amount (₹)</th></tr>${rows}
      ${Number(d.gatewayFee) > 0 ? `<tr><td>Convenience fee</td><td class="num">${m(d.gatewayFee)}</td></tr>` : ''}</table>
    ${signBlock(d.seller)}</body></html>`;
}
