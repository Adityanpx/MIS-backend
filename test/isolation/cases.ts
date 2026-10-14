/** Ids belonging to the OTHER tenant (B) that the attacker (A's Client Admin) tries to reach. */
export interface Victim { tenantId: string; plantId: string; userId: string; adminId: string }
export interface Attacker { plantId: string; userId: string }

export interface IsolationCase {
  route: string; // exactly as listRoutes() prints it, e.g. 'GET /plants/:plantId'
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: (b: Victim, a: Attacker) => string;
  body?: (b: Victim, a: Attacker) => object;
  expectStatus?: number; // default 404
}

export const CASES: IsolationCase[] = [
  { route: 'GET /plants/:plantId', method: 'get', path: (b) => `/plants/${b.plantId}` },
  { route: 'GET /company/users/:id', method: 'get', path: (b) => `/company/users/${b.userId}` },
  { route: 'PATCH /company/users/:id', method: 'patch', path: (b) => `/company/users/${b.userId}`, body: () => ({ name: 'Hacked Name' }) },
  { route: 'POST /company/users/:id/disable', method: 'post', path: (b) => `/company/users/${b.adminId}/disable` },
  { route: 'POST /company/users/:id/enable', method: 'post', path: (b) => `/company/users/${b.userId}/enable` },
  { route: 'POST /company/users/:id/resend-invite', method: 'post', path: (b) => `/company/users/${b.userId}/resend-invite` },
  { route: 'POST /company/users/:id/reset-password', method: 'post', path: (b) => `/company/users/${b.userId}/reset-password` },
  { route: 'PUT /company/users/:id/plant-roles', method: 'put', path: (b) => `/company/users/${b.userId}/plant-roles`, body: () => ({ roles: [] }) },
  // foreign references inside a body of an otherwise valid request:
  { route: 'PUT /company/users/:id/plant-roles', method: 'put', path: (_b, a) => `/company/users/${a.userId}/plant-roles`,
    body: (b) => ({ roles: [{ plantId: b.plantId, role: 'viewer' }] }) },
  { route: 'POST /company/users', method: 'post', path: () => '/company/users',
    body: (b) => ({ name: 'Cross Tenant', email: 'cross-tenant@test.local', plantRoles: [{ plantId: b.plantId, role: 'viewer' }] }) },
];

/** Routes without a foreign id. Each needs a reason; list endpoints are checked separately for leaks. */
export const EXEMPT: Record<string, string> = {
  'POST /auth/login': 'public', 'POST /auth/2fa/verify': 'public (signed mfa token)',
  'POST /auth/2fa/enrol/start': 'public (signed mfa token)', 'POST /auth/2fa/enrol/confirm': 'public (signed mfa token)',
  'POST /auth/refresh': 'cookie token', 'POST /auth/logout': 'cookie token', 'POST /auth/forgot': 'public',
  'POST /auth/reset': 'single-use token', 'POST /auth/invite/accept': 'single-use token',
  'POST /auth/logout-all': 'self', 'GET /public/platform': 'public, platform-wide',
  'GET /files/local': 'HMAC-signed URL (dev/test only)',
  'GET /me': 'self', 'PATCH /me': 'self', 'POST /me/password': 'self', 'POST /me/2fa/setup': 'self',
  'POST /me/2fa/enable': 'self', 'POST /me/2fa/disable': 'self', 'POST /me/accept-terms': 'own tenant',
  'GET /company': 'own tenant (leak check below)', 'PATCH /company': 'own tenant', 'POST /company/logo': 'own tenant',
  'GET /company/users': 'list (leak check below)', 'GET /company/audit': 'list (leak check below)',
  'GET /plants': 'list (leak check below)',
  'GET /company/portfolio': 'own tenant only (built from listPlants, same as /plants)',
};

export interface Victim2 extends Victim { paramId: string; stockItemId: string; bgId: string; notificationId: string; exportId: string; pdfId: string; importId: string; correctionId: string }

/** Fills :params of a route for the generic plant rule. */
export function fillPlantRoute(route: string, b: Victim): { method: IsolationCase['method']; path: string } {
  const [m, p] = route.split(' ') as [string, string];
  const path = p.replace(':plantId', b.plantId).replace(/:id|:pdfId/g, '00000000-0000-4000-8000-000000000000')
    .replace(':date', '2025-01-01').replace(':yearNo', '1');
  return { method: m.toLowerCase() as IsolationCase['method'], path };
}

export const CASES_P2 = (b: Victim2, a: Attacker): Array<{ method: IsolationCase['method']; path: string; body?: object }> => [
  { method: 'get', path: `/plants/${a.plantId}/settings/parameters/${b.paramId}` },
  { method: 'patch', path: `/plants/${a.plantId}/settings/parameters/${b.paramId}`, body: { name: 'Hacked' } },
  { method: 'post', path: `/plants/${a.plantId}/settings/parameters/${b.paramId}/standards`, body: { std: 1 } },
  { method: 'patch', path: `/plants/${a.plantId}/settings/stock-items/${b.stockItemId}`, body: { name: 'Hacked' } },
  { method: 'patch', path: `/plants/${a.plantId}/settings/bank-guarantees/${b.bgId}`, body: { label: 'Hacked' } },
  { method: 'post', path: `/plants/${a.plantId}/settings/copy-from`, body: { sourcePlantId: b.plantId } },
  { method: 'post', path: `/plants/${a.plantId}/logsheets/correction-requests/${b.correctionId}/approve`, body: {} },
  { method: 'get', path: `/plants/${a.plantId}/pdfs/${b.pdfId}/download` },
  { method: 'get', path: `/plants/${a.plantId}/imports/${b.importId}` },
  { method: 'post', path: '/notifications/' + b.notificationId + '/read' },
  { method: 'get', path: `/exports/${b.exportId}` },
  { method: 'get', path: `/exports/${b.exportId}/download` },
];

/** Non-plant Phase 2 routes: covered by CASES_P2 or self-scoped. */
Object.assign(EXEMPT, {
  'GET /notifications': 'self (leak check)', 'POST /notifications/read-all': 'self',
  'GET /notifications/preferences': 'self', 'PUT /notifications/preferences': 'self',
  'POST /notifications/:id/read': 'CASES_P2', 'GET /exports/:id': 'CASES_P2', 'GET /exports/:id/download': 'CASES_P2',
});

export interface Victim3 { tenantId: string; plantId: string; invoiceId: string; receiptId: string; creditNoteId: string }

/** Every request must return 404 and leave tenant B unchanged. Bodies are valid, so only the tenant filter can stop them. */
export const CASES_P3 = (b: Victim3): Array<{ method: IsolationCase['method']; path: string; body?: object }> => [
  { method: 'get', path: `/billing/invoices/${b.invoiceId}` },
  { method: 'get', path: `/billing/invoices/${b.invoiceId}/pdf` },
  { method: 'post', path: `/billing/invoices/${b.invoiceId}/pay-link` },
  { method: 'post', path: `/billing/invoices/${b.invoiceId}/payment-notifications`, body: { amount: '100', paidOn: '2026-01-01', reference: 'UTR-X-1' } },
  { method: 'post', path: `/billing/invoices/${b.invoiceId}/tds`, body: { amount: '10', section: '194J', deductionDate: '2026-01-01' } },
  { method: 'get', path: `/billing/receipts/${b.receiptId}/pdf` },
  { method: 'get', path: `/billing/credit-notes/${b.creditNoteId}/pdf` },
  { method: 'post', path: '/company/exports', body: { plantIds: [b.plantId] } },
];

Object.assign(EXEMPT, {
  'POST /auth/act-as/exchange': 'single-use code; the tenant comes from the session row',
  'GET /billing/summary': 'own tenant (leak check)', 'GET /billing/subscriptions': 'own tenant (leak check)',
  'GET /billing/invoices': 'list (leak check)', 'GET /billing/payments': 'list (leak check)', 'GET /billing/credit': 'own tenant',
  'GET /billing/payment-notifications': 'list (leak check)', 'GET /banners': 'self (leak check)',
  'GET /announcements': 'tenant via RLS function', 'GET /company/exports': 'list (leak check)',
  'GET /billing/invoices/:id': 'CASES_P3', 'GET /billing/invoices/:id/pdf': 'CASES_P3', 'POST /billing/invoices/:id/pay-link': 'CASES_P3',
  'POST /billing/invoices/:id/payment-notifications': 'CASES_P3', 'POST /billing/invoices/:id/tds': 'CASES_P3',
  'GET /billing/receipts/:id/pdf': 'CASES_P3', 'GET /billing/credit-notes/:id/pdf': 'CASES_P3',
  'POST /company/exports': 'CASES_P3 (foreign plantIds)',
});

Object.assign(EXEMPT, { 'GET /overview': 'own plants only (leak check in file2-isolation.test.ts)' });
