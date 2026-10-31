# Acceptance scenarios (Schedule A Part 4(c))

**Agreement:** Software Development, Confidentiality and Source Code Handover Agreement,
Averix Solutions Pvt Ltd × Mr. Rajesh Patil, effective 8 October 2026.

**Clause:** Schedule A Part 4(c) — "The test scenarios **T01 to T30** in section 25.2 of
the PRD have been run on the staging environment, using the payment gateway in test mode,
with no Critical or High defect open."

**Reference:** Product Requirements Document **v1.1 dated 08-Oct-2026**, section 25.2.
v1.1 supersedes the earlier v1.0 of 06-Oct-2026 and is the version named by the Agreement
(Definitions clause).

Run only the acceptance scenarios:

```bash
npm run test:acceptance
```

---

## Status — scenario titles finalised; test bodies pending

Each T-ID now carries the full title from PRD v1.1 §25.2. The tests themselves are still
`it.todo`, so `npm run test:acceptance` reports 30 pending scenarios. Replacing each
`it.todo` with a real `it(...)` closes clause (c). The work does **not** need any schema
or engine change — every scenario is served by endpoints and helpers that already exist
in `src/` and `test/helpers*.ts`.

A scenario is tagged **[CRITICAL]** when its failure meets Schedule A Part 4's Critical
definition ("prevents core use of the Application, loses data, or exposes one client's
data to another"). A failing Critical blocks acceptance; a failing High blocks it unless
a workaround exists.

## Scenario inventory (v1.1 §25.2)

| T-ID | PRD title (verbatim) | Severity | File |
|------|---|---|---|
| T01  | Super Admin creates client → plant (60 months) → subscription (5-year plan, ₹60,000, yearly) | High | `t-billing.test.ts` |
| T02  | Tenure 181 months or a 16-year subscription | High | `t-super-admin.test.ts` |
| T03  | Client Admin completes settings | High | `t-super-admin.test.ts` |
| T04  | Editor submits a logsheet with outlet BOD 12 (limit 10) | High | `t-logsheet.test.ts` |
| T05  | Editor enters "abc" or −5 in a numeric field | Medium | `t-logsheet.test.ts` |
| T06  | Correction by Client Admin with reason | High | `t-logsheet.test.ts` |
| T07  | Pay invoice via Razorpay (test mode) | High | `t-billing.test.ts` |
| T08  | Record a cheque → bounce | Medium | `t-billing.test.ts` |
| T09  | Unpaid invoice timeline (simulated clock) | High | `t-lifecycle.test.ts` |
| T10  | Partial payment + TDS | Medium | `t-billing.test.ts` |
| T11  | One NEFT allocated across 3 invoices with excess | Medium | `t-billing.test.ts` |
| T12  | Cash ≥ ₹2,00,000 in a day | Medium | `t-billing.test.ts` |
| T13  | Tenant isolation test | **CRITICAL** | `t-isolation.test.ts` |
| T14  | Import the Excel DATA ENTRY sheet | High | `t-imports-exports.test.ts` |
| T15  | Monthly report for Sep-2026 (BGE hours, BGE kWh) | High | `t-engine.test.ts` |
| T16  | BG with an end date before D | Medium | `t-mis-reports.test.ts` |
| T17  | Dashboard arrows | Medium | `t-mis-reports.test.ts` |
| T18  | Plan price edit | Medium | `t-super-admin.test.ts` |
| T19  | Act-as by Super Admin | Medium | `t-super-admin.test.ts` |
| T20  | Full data export | Medium | `t-imports-exports.test.ts` |
| T21  | Two standards: set Bidding BGE kWh 13,000 and Actual 11,800 | High | `t-engine.test.ts` |
| T22  | Results: Chlorine on 21-Sep-2026, Actual standard | High | `t-engine.test.ts` |
| T23  | Management user logs in | High | `t-auth.test.ts` |
| T24  | Portfolio with 3 plants (one missing logsheet, one critical breakdown open, one outlet exceeded) | High | `t-mis-reports.test.ts` |
| T25  | Log a breakdown on critical equipment, then restore it | High | `t-maintenance.test.ts` |
| T26  | Breakdown opened 10-Sep, restored 15-Sep | High | `t-maintenance.test.ts` |
| T27  | Breakdown crossing a month boundary; two overlapping breakdowns on one equipment | Medium | `t-maintenance.test.ts` |
| T28  | MIS PDF for a date | **CRITICAL** (also Schedule A Part 4(d), covered by `test/unit/pdf-mis-pages.test.ts`) | `t-mis-reports.test.ts` |
| T29  | Submit a logsheet without ticking "Breakdown status reviewed" | Medium | `t-logsheet.test.ts` |
| T30  | Tenant isolation including Management and the new routes | **CRITICAL** | `t-isolation.test.ts` |

## Shared helpers

Every cluster file reuses:

- `test/helpers.ts` — Supertest `app`, cookie helpers, mailbox drain, `uniq()`, `PASSWORD`.
- `test/phase2-helpers.ts`, `test/phase3-helpers.ts` — tenant/plant builders, logsheet fixtures.
- `test/golden/fixture.ts` — `goldenInput()` for engine / MIS calculation scenarios (T15, T21, T22).
- `src/modules/billing/razorpay/gateway.ts` — `fakeRazorpay` for the test-mode payment path
  the Agreement names (T07, T10).

Fixtures are **not** copied into `test/acceptance/`. They are imported from the paths above.

## Severity convention in test titles

Each `it(...)` title prefixes its T-ID. Critical tests also carry the inline tag so they
are visually obvious in CI output and greppable:

```ts
it('T13 [CRITICAL] — tenant A token with tenant B IDs returns 404/403', async () => { … });
```

High and Medium scenarios omit the tag. Low scenarios do not appear in v1.1 §25.2.
