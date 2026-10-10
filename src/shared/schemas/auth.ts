import { z } from 'zod';
import { email, mobile, password, personName } from './common';

export const loginBody = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const mfaVerifyBody = z.object({ mfaToken: z.string().min(10), code: z.string().regex(/^\d{6}$/) }).strict();
export const mfaTokenBody = z.object({ mfaToken: z.string().min(10) }).strict();
export const forgotBody = z.object({ email }).strict();
export const resetBody = z.object({ token: z.string().min(20).max(200), password }).strict();
export const inviteAcceptBody = z.object({ token: z.string().min(20).max(200), password }).strict();
export const changePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: password })
  .strict();
export const codeBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const mePatchBody = z
  .object({ name: personName.optional(), mobile: mobile.optional(), designation: z.string().trim().max(100).optional() })
  .strict();
