import { todayIST } from '../../lib/dates';
import { logger } from '../../lib/logger';
import type { ClientCtx } from '../../types/express';
import type { StandardKind } from '../../shared/enums';
import { getBundle } from '../engine/engine.service';
import { buildMis } from '../engine/core/mis';
import { listPlants } from '../plants/plants.service';
import {
  buildPortfolioRow, REPORTING_ACCOUNT_STATES, sortIssues, summarize,
  type PlantInput, type PortfolioIssue, type PortfolioRow, type PortfolioSummary,
} from './portfolio.rows';

export type { PortfolioIssue, PortfolioRow, PortfolioSummary } from './portfolio.rows';

const CONCURRENCY = 10;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface PortfolioReport {
  reportDate: string;
  today: string;
  standard: StandardKind | 'primary';
  summary: PortfolioSummary;
  rows: PortfolioRow[];
  issues: PortfolioIssue[];
}

/**
 * GET /api/v1/company/portfolio (MGT-11, §16A/C3): one row per plant of the company plus every system-detected issue.
 * Each row is built from the same MIS report the plant pages show (getBundle + buildMis), never a separate data path.
 */
export async function portfolio(ctx: ClientCtx, date: string, standard: StandardKind | 'primary'): Promise<PortfolioReport> {
  const today = todayIST();
  const plants = await listPlants(ctx);
  const built = await mapLimit(plants, CONCURRENCY, async (p) => {
    const reporting = p.setupStatus === 'live' && (REPORTING_ACCOUNT_STATES as readonly string[]).includes(p.accountState);
    let input: PlantInput;
    if (!reporting) input = { kind: 'not_live' };
    else if (date > today || date < p.misStart) input = { kind: 'not_due' };
    else {
      try {
        const b = await getBundle(ctx.tenantId, p.id);
        input = date < b.settings.plant.misStart
          ? { kind: 'not_due' }
          : { kind: 'mis', mis: buildMis(b, date), longOpenAlertDays: b.settings.maintenance.longOpenAlertDays };
      } catch (err) {
        logger.warn({ err, plantId: p.id, date }, 'portfolio: MIS could not be built');
        input = { kind: 'unavailable' };
      }
    }
    return buildPortfolioRow(p, input, { standard, date, today });
  });
  const rows = built.map((b) => b.row);
  const issues = sortIssues(built.flatMap((b) => b.issues));
  return { reportDate: date, today, standard, summary: summarize(rows, issues), rows, issues };
}

/** Lets the route default to "today" without importing lib/dates itself. */
export const portfolioDefaultDate = (): string => todayIST();
