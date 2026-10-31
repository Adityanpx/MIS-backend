# OMMIS Backend

Multi-tenant O&M MIS platform API: Node.js 22 + Express 4 + TypeScript + PostgreSQL.

## Prerequisites
- Node 22+
- Docker (local Postgres 16) or any Postgres 16 with databases `ommis_dev` and `ommis_test`

## Setup
```bash
cp .env.example .env
cp .env.test.example .env.test
# generate ENCRYPTION_KEY and put it in .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
docker compose up -d
npm ci
npm run db:migrate
npm run db:seed
SUPER_ADMIN_PASSWORD='Str0ngPassw0rd!' npm run create-super-admin -- --email you@x.com --name "You"
npm run dev
```

## Testing
`npm test` resets and migrates the `ommis_test` database automatically, then runs unit,
integration and tenant-isolation tests. Also run `npm run typecheck`, `npm run lint`, `npm run check-rls`.

## Acceptance tests (Agreement Schedule A Part 4)
- (a) Calculation correctness: `test/golden/`
- (b) Multi-tenant isolation: `test/isolation/`
- (c) PRD §25.2 scenarios T01–T30: `test/acceptance/`
- (d) MIS PDF exactly 5 pages: `test/unit/pdf-mis-pages.test.ts`

Run everything with `npm test`. Run only (c) with `npm run test:acceptance`.

## Folder structure
```
src/
  server.ts, app.ts
  config/       env + constants
  lib/          errors, http, logger, dates, crypto, password, jwt, totp, pagination, cookies, money, validate, context
  shared/       framework-free enums, constants, zod schemas (to be shared with frontends)
  db/           pools, tenant (withTenant/withAdmin/withSystem/withAuthLookup), sql, types, migrate, reset,
                migrations/*.sql, seeds/
  middleware/   request-id, http-logger, security, rate-limit, error-handler, auth-client, auth-admin,
                require-role, plant-access, account-state, internal-auth
  routes/       client.routes.ts, admin.routes.ts
  modules/      admin/{act-as, announcements, audit, billing, clients, dashboard, deletion, notifications,
                       plans, plants, reports, settings, subscriptions, super-admins, usage},
                admin-auth, audit, auth, billing, client-billing, company, domain, engine, exports,
                files, health, imports, insights, lifecycle, logsheets, maintenance, notifications,
                pdf, plants, platform, reports, settings, users
scripts/        create-super-admin.ts, check-rls.ts
test/           unit/, integration/, isolation/, golden/, acceptance/
```
