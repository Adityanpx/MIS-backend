import { z } from 'zod';

/**
 * Widgets of the plant dashboard (frontend File 2). The order of this list is the default layout.
 * Adding a widget later = append its id here (old saved layouts stay valid).
 */
export const DASHBOARD_WIDGETS = [
  'kpis', 'trend', 'alerts', 'chemicals', 'last7', 'compliance', 'params', 'quality', 'cash', 'staff', 'registers',
] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGETS)[number];
export const DEFAULT_DASHBOARD_WIDGETS: DashboardWidgetId[] = [...DASHBOARD_WIDGETS];

export const dashboardLayout = z
  .object({
    version: z.literal(1),
    /** visible widgets, in display order */
    widgets: z
      .array(z.enum(DASHBOARD_WIDGETS))
      .max(DASHBOARD_WIDGETS.length)
      .refine((w) => new Set(w).size === w.length, 'Each widget can be added only once'),
    /** parameter shown in the trend / last-7-days widgets (null = the plant's first key parameter) */
    focus: z.string().regex(/^[A-Z0-9_]{1,40}$/).nullable().optional(),
  })
  .strict();
export type DashboardLayout = z.infer<typeof dashboardLayout>;

export const dashboardLayoutBody = z.object({ layout: dashboardLayout }).strict();
