import type { RequestHandler } from 'express';
import { lockedState, unauthorized } from '../lib/errors';

export type RouteClass = 'read' | 'write' | 'billing';

/** Uses the plant's state on plant routes, otherwise the tenant's rolled-up state. */
export function accountState(kind: RouteClass): RequestHandler {
  return (req, _res, next) => {
    const ctx = req.ctx;
    if (!ctx) return next(unauthorized());
    const state = req.plant?.accountState ?? ctx.tenantAccountState;
    switch (state) {
      case 'active':
      case 'grace':
        return next();
      case 'read_only':
      case 'expired':
        return kind === 'write'
          ? next(lockedState('ACCOUNT_READ_ONLY', 'This account is read-only until the pending payment is made.'))
          : next();
      case 'suspended':
        return kind === 'billing' && ctx.isClientAdmin
          ? next()
          : next(lockedState('ACCOUNT_SUSPENDED', 'This account is suspended. Please contact your administrator.'));
      case 'terminated':
        return kind === 'billing' && ctx.isClientAdmin
          ? next()
          : next(lockedState('ACCOUNT_TERMINATED', 'This account has been terminated.'));
      default:
        return next(lockedState('ACCOUNT_SUSPENDED', 'This account is not active.'));
    }
  };
}
