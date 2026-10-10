import type { PlantRole } from '../shared/enums';

export interface ClientCtx {
  tenantId: string;
  userId: string;
  isClientAdmin: boolean;
  plantRoles: Record<string, PlantRole>;
  tenantAccountState: string;
  tenantTermsVersion: string | null;
  actingAsAdminId?: string;
  actAsMode?: 'view' | 'edit';
}
export interface AdminCtx {
  adminId: string;
}
export interface PlantCtx {
  id: string;
  name: string;
  setupStatus: string;
  accountState: string;
  omStart: string;
  omEnd: string;
  misStart: string;
  myRole: PlantRole | 'client_admin';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      ctx?: ClientCtx;
      adminCtx?: AdminCtx;
      plant?: PlantCtx;
    }
  }
}
export {};
