import { z } from 'zod';
import { PLANT_ROLES } from '../enums';
import { contact, email, mobile, personName, uuid } from './common';

export const companyPatchBody = z
  .object({
    displayName: z.string().trim().min(2).max(150).optional(),
    primaryContact: contact.optional(),
    billingEmails: z.array(email).min(1).max(3).optional(),
  })
  .strict();
const plantRole = z.object({ plantId: uuid, role: z.enum(PLANT_ROLES) }).strict();
export const userInviteBody = z
  .object({
    name: personName,
    email,
    mobile: mobile.optional(),
    designation: z.string().trim().max(100).optional(),
    isClientAdmin: z.boolean().default(false),
    plantRoles: z.array(plantRole).max(200).default([]),
  })
  .strict();
export const userPatchBody = z
  .object({
    name: personName.optional(),
    mobile: mobile.nullable().optional(),
    designation: z.string().trim().max(100).nullable().optional(),
    isClientAdmin: z.boolean().optional(),
  })
  .strict();
export const plantRolesPutBody = z.object({ roles: z.array(plantRole).max(200) }).strict();
