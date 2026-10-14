import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { currentTermsVersion } from '../modules/platform/settings.service';

export const requireClientAdmin: RequestHandler = (req, _res, next) => {
  if (!req.ctx) return next(unauthorized());
  if (!req.ctx.isClientAdmin) return next(forbidden('FORBIDDEN_ROLE', 'Only a Client Admin can do this.'));
  next();
};

/** v1.1: billing, user management, and the audit trail are never visible to a Management user. */
export const forbidManagement: RequestHandler = (req, _res, next) => {
  if (!req.ctx) return next(unauthorized());
  if (req.ctx.isManagement) return next(forbidden('FORBIDDEN_ROLE', 'Not available for Management users.'));
  next();
};

/** v1.1: the company portfolio is visible to a Client Admin or a Management user (read-only). */
export const requireClientAdminOrManagement: RequestHandler = (req, _res, next) => {
  if (!req.ctx) return next(unauthorized());
  if (!req.ctx.isClientAdmin && !req.ctx.isManagement) {
    return next(forbidden('FORBIDDEN_ROLE', 'This page requires a Client Admin or Management role.'));
  }
  next();
};

/** PRD AUTH-12: a Client Admin must accept the current Terms before using the app. */
export const requireTermsAccepted: RequestHandler = asyncHandler(async (req, _res, next) => {
  const ctx = req.ctx;
  if (!ctx) throw unauthorized();
  if (ctx.isClientAdmin && !ctx.actingAsAdminId) {
    const current = await currentTermsVersion();
    if (current && ctx.tenantTermsVersion !== current) {
      throw forbidden('TERMS_NOT_ACCEPTED', 'Please accept the Terms of Service to continue.');
    }
  }
  next();
});
