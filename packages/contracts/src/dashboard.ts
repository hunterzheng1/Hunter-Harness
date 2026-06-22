import { z } from "zod";

export const dashboardHealthStatusSchema = z.enum(["healthy", "attention", "unavailable"]);
export const dashboardServiceStatusSchema = z.enum(["operational", "degraded", "unavailable"]);

export const dashboardTrendPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  submitted: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative()
}).strict();

export const dashboardDistributionItemSchema = z.object({
  key: z.string().min(1),
  count: z.number().int().nonnegative()
}).strict();

export const dashboardHealthItemSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: dashboardHealthStatusSchema,
  value: z.string().min(1),
  detail: z.string().min(1)
}).strict();

export const dashboardServiceItemSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: dashboardServiceStatusSchema,
  detail: z.string().min(1),
  checked_at: z.iso.datetime()
}).strict();

export const dashboardActivitySchema = z.object({
  event_id: z.string().min(1),
  action: z.string().min(1),
  target_id: z.string().min(1),
  project_id: z.string().nullable(),
  actor_id: z.string().min(1),
  created_at: z.iso.datetime()
}).strict();

export const dashboardOverviewSchema = z.object({
  generated_at: z.iso.datetime(),
  window: z.object({
    days: z.number().int().min(7).max(30),
    starts_at: z.iso.datetime(),
    ends_at: z.iso.datetime()
  }).strict(),
  metrics: z.object({
    projects: z.number().int().nonnegative(),
    workflows: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    published_skills: z.number().int().nonnegative(),
    pending_reviews: z.number().int().nonnegative(),
    approved_proposals: z.number().int().nonnegative(),
    rejected_proposals: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    project_artifacts: z.number().int().nonnegative(),
    skill_artifacts: z.number().int().nonnegative()
  }).strict(),
  trend: z.array(dashboardTrendPointSchema),
  distributions: z.object({
    skill_categories: z.array(dashboardDistributionItemSchema),
    workflow_profiles: z.array(dashboardDistributionItemSchema)
  }).strict(),
  health: z.array(dashboardHealthItemSchema),
  services: z.array(dashboardServiceItemSchema),
  activity: z.array(dashboardActivitySchema)
}).strict();

export type DashboardOverview = z.infer<typeof dashboardOverviewSchema>;
