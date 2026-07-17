import type { ProjectSummary } from "./api";

export const PROJECT_LIST_PAGE_SIZE = 6;

export function projectUpdatedAtMs(project: ProjectSummary): number {
  return Date.parse(project.updated_at ?? project.created_at);
}

export function projectMatchesQuery(project: ProjectSummary, needle: string): boolean {
  if (needle === "") return true;
  const q = needle.toLowerCase();
  return project.display_name.toLowerCase().includes(q)
    || project.project_id.toLowerCase().includes(q);
}

/** Newest update first; display_name tie-break for stable ordering. */
export function sortProjectsByUpdatedDesc(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((left, right) => {
    const delta = projectUpdatedAtMs(right) - projectUpdatedAtMs(left);
    if (delta !== 0) return delta;
    return left.display_name.localeCompare(right.display_name);
  });
}

/** Full local datetime including seconds (e.g. 2026/7/17 14:30:00). */
export function formatProjectDateTime(iso: string, lang: "zh" | "en"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

export function paginateProjects<T>(items: T[], page: number, pageSize = PROJECT_LIST_PAGE_SIZE): {
  pageCount: number;
  safePage: number;
  pageItems: T[];
} {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const pageItems = items.slice(safePage * pageSize, (safePage + 1) * pageSize);
  return { pageCount, safePage, pageItems };
}
