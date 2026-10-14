import type { RequestHandler } from 'express';
import { maybeOne } from '../db/sql';
import { withTenant } from '../db/tenant';
import { forbidden, notFound, unauthorized } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import type { PlantRole } from '../shared/enums';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function plantAccess(allowed: PlantRole[] | 'any'): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const ctx = req.ctx;
    if (!ctx) throw unauthorized();
    const plantId = req.params.plantId ?? '';
    if (!UUID_RE.test(plantId)) throw notFound('Plant');
    const role = ctx.isClientAdmin ? 'client_admin' : ctx.isManagement ? 'management' : ctx.plantRoles[plantId];
    if (!role) throw notFound('Plant');
    const plant = await withTenant({ tenantId: ctx.tenantId, actorId: ctx.userId }, (tx) =>
      maybeOne<{ id: string; name: string; setup_status: string; account_state: string; om_start: string; om_end: string; mis_start: string }>(
        tx,
        `SELECT id, name, setup_status, account_state, om_start, om_end, mis_start
           FROM app.plants WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, plantId],
      ),
    );
    if (!plant) throw notFound('Plant');
    // Management is company-wide read-only (GR-17): it never satisfies a write-role requirement.
    if (role !== 'client_admin' && role !== 'management' && allowed !== 'any' && !allowed.includes(role)) {
      throw forbidden('FORBIDDEN_ROLE', 'Your role on this plant does not allow this action.');
    }
    if (role === 'management' && allowed !== 'any') {
      throw forbidden('FORBIDDEN_ROLE', 'Management users are read-only.');
    }
    req.plant = {
      id: plant.id, name: plant.name, setupStatus: plant.setup_status, accountState: plant.account_state,
      omStart: plant.om_start, omEnd: plant.om_end, misStart: plant.mis_start, myRole: role,
    };
    next();
  });
}
