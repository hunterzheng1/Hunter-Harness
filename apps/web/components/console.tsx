"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type {
  DashboardOverview,
  RegistrySkillDetail
} from "@hunter-harness/contracts";

import {
  browserApi,
  type HunterApi,
  type ProjectSummary
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { apiError, Status } from "./skill-shared";

export { ProjectRegistry } from "./project-registry";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function DashboardConsole({ api: propApi }: { api?: HunterApi }) {
  const { t, lang } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [skills, setSkills] = useState<RegistrySkillDetail[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([
      api.getDashboardOverview(7),
      api.listProjects(),
      api.listSkills?.() ?? Promise.resolve([])
    ])
      .then(([nextOverview, nextProjects, nextSkills]) => {
        if (!active) return;
        setOverview(nextOverview);
        setProjects(nextProjects);
        setSkills(nextSkills);
      })
      .catch((reason: unknown) => {
        if (active) setError(apiError(reason, t));
      });
    return () => {
      active = false;
    };
  }, [api, t]);

  if (error !== null) return <Empty>{error}</Empty>;
  if (overview === null) {
    return <Empty>{t.dashboard.loading}</Empty>;
  }

  const attention = overview.health.some((item) => item.status === "attention");
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const metricCards = [
    { label: t.dashboard.registeredProjects, value: overview.metrics.projects, href: "/projects", icon: "projects" as const },
    { label: t.dashboard.workflows, value: overview.metrics.workflows, href: "/workflows", icon: "workflow" as const },
    { label: t.dashboard.publishedSkills, value: overview.metrics.published_skills, href: "/skills", icon: "skill" as const }
  ];

  return (
    <section className="stack governance-page page-module-v2 dashboard-stack">
      <header className="project-registry-hero">
        <div>
          <p className="eyebrow">{t.dashboard.eyebrow}</p>
          <h1>{t.dashboard.title}</h1>
          <p>{t.dashboard.subtitle.replace("{days}", String(overview.window.days)).replace("{time}", new Date(overview.generated_at).toLocaleString(locale))}</p>
        </div>
        <Status value={attention ? "attention" : "clear"} />
      </header>

      <div className="dashboard-metric-grid">
        {metricCards.map((metric) => (
          <Link className="dashboard-metric" href={metric.href} key={metric.label}>
            <DashboardIcon name={metric.icon} />
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
            <small>{t.dashboard.view}</small>
          </Link>
        ))}
      </div>

      <div className="dashboard-main-grid">
        <section className="panel dashboard-chart-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.sevenDaySignal}</p><h2>{t.dashboard.proposalActivity}</h2></div>
            <div className="chart-legend"><span className="submitted">{t.dashboard.submitted}</span><span className="approved">{t.dashboard.approved}</span><span className="rejected">{t.dashboard.rejected}</span></div>
          </div>
          <TrendChart trend={overview.trend} />
        </section>

        <section className="panel dashboard-distribution-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.registryComposition}</p><h2>{t.dashboard.skillDistribution}</h2></div><span>{overview.metrics.skills} {t.dashboard.total}</span></div>
          <DistributionChart items={overview.distributions.skill_categories} />
        </section>
      </div>

      <div className="dashboard-work-grid">
        <section className="panel dashboard-work-panel dashboard-project-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.projectsPanelEyebrow}</p><h2>{t.dashboard.recentProjects}</h2></div>
            <Link href="/projects">{t.dashboard.viewAll}</Link>
          </div>
          <div className="dashboard-project-list">
            {projects.length === 0 ? <Empty>{t.dashboard.noProjects}</Empty> : projects.slice(0, 4).map((project) => (
              <Link href={`/projects/${project.project_id}`} key={project.project_id}>
                <span className="dashboard-project-mark" aria-hidden="true">{project.display_name.slice(0, 1).toUpperCase()}</span>
                <div><strong>{project.display_name}</strong><code>{project.latest_project_version ?? t.dashboard.noVersion}</code></div>
                <span className="dashboard-role">{project.role}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="panel dashboard-work-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.skillsPanelEyebrow}</p><h2>{t.dashboard.skillUsage}</h2></div>
            <Link href="/skills">{t.dashboard.openSkills}</Link>
          </div>
          <div className="skill-usage-summary">
            <div><span>{t.dashboard.publishedCoverage}</span><strong>{overview.metrics.published_skills}/{overview.metrics.skills}</strong><i><b style={{ width: `${overview.metrics.skills === 0 ? 0 : (overview.metrics.published_skills / overview.metrics.skills) * 100}%` }} /></i></div>
            <div><span>{t.dashboard.workflowBindings}</span><strong>{overview.metrics.workflows}</strong><small>{t.dashboard.activeWorkflows}</small></div>
          </div>
          <div className="dashboard-skill-list">
            {skills.slice(0, 3).map((skill) => <Link href={`/skills/${skill.slug}`} key={skill.skill_id}><span>{skill.kind ?? t.dashboard.unknownKind}</span><strong>{skill.name}</strong><code>{skill.latest_version ?? t.dashboard.unversioned}</code></Link>)}
            {skills.length === 0 ? <Empty>{t.dashboard.noSkills}</Empty> : null}
          </div>
        </section>
      </div>

      <div className="dashboard-lower-grid">
        <section className="panel dashboard-list-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.controlChecks}</p><h2>{t.dashboard.governanceHealth}</h2></div><Status value={attention ? "attention" : "clear"} /></div>
          <div className="signal-list">
            {overview.health.map((item) => <article className="health-row" key={item.key}><Status value={item.status} /><div><strong>{localizeDashboardLabel(item.label, lang)}</strong><p>{localizeDashboardDetail(item.detail, lang)}</p></div><b>{localizeDashboardValue(item.value, lang)}</b></article>)}
          </div>
        </section>

        <section className="panel dashboard-list-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.liveReads}</p><h2>{t.dashboard.systemSignals}</h2></div><span>{new Date(overview.generated_at).toLocaleTimeString(locale)}</span></div>
          <div className="signal-list">
            {overview.services.map((service) => <article className="service-row" key={service.key}><span className={`service-dot ${service.status}`} aria-hidden="true" /><div><strong>{localizeDashboardLabel(service.label, lang)}</strong><p>{localizeDashboardDetail(service.detail, lang)}</p></div><Status value={service.status} /></article>)}
          </div>
        </section>

        <section className="panel dashboard-list-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.immutableEvidence}</p><h2>{t.dashboard.recentActivity}</h2></div><Link href="/projects">{t.dashboard.openRegistry}</Link></div>
          <div className="activity-list">
            {overview.activity.length === 0 ? <Empty>{t.dashboard.noActivity}</Empty> : overview.activity.map((event) => <article key={event.event_id}><DashboardIcon name="activity" /><div><strong>{event.action}</strong><p>{event.target_id} · {event.project_id ?? t.dashboard.registryScope}</p></div><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString(locale)}</time></article>)}
          </div>
        </section>
      </div>

      <section className="dashboard-actions">
        <div>
          <p className="eyebrow">{t.dashboard.nextAction}</p>
          <strong>{overview.metrics.pending_reviews === 0 ? t.dashboard.queueClear : `${overview.metrics.pending_reviews} ${t.dashboard.needReview}`}</strong>
          <span>{overview.metrics.pending_reviews === 0 ? t.dashboard.queueClearHint : t.dashboard.needReviewHint}</span>
        </div>
        <div className="dashboard-action-links">
          <Link href="/projects">{t.dashboard.openRegistry}</Link>
          <Link href="/workflows">{t.dashboard.maintainWorkflows}</Link>
          <Link href="/skills">{t.dashboard.browseSkills}</Link>
        </div>
      </section>
    </section>
  );
}

function localizeDashboardLabel(label: string, lang: "zh" | "en"): string {
  if (lang !== "zh") return label;
  const map: Record<string, string> = {
    "Review backlog": "待处理审核",
    "Review outcome": "审核结果",
    "Artifact traceability": "版本可追溯",
    "Audit evidence": "操作记录",
    "Governance API": "治理接口",
    "Project repository": "项目数据",
    "Skill registry": "技能库",
    "Audit log": "操作日志"
  };
  return map[label] ?? label;
}

function localizeDashboardDetail(detail: string, lang: "zh" | "en"): string {
  if (lang !== "zh") return detail;
  const map: Record<string, string> = {
    "Human review is required before pending proposals can publish.": "还有变更等待人工确认后才能发布。",
    "Calculated from recorded review decisions.": "根据已记录的审核结果统计。",
    "Every demo artifact has a governed source.": "每个版本都有对应来源记录。",
    "Recent immutable audit entries are available.": "近期操作记录可查。",
    "Authenticated overview request completed.": "总览接口访问正常。",
    "Projects, proposals, and artifacts were read successfully.": "项目与版本数据读取正常。",
    "Skill and Workflow metadata were read successfully.": "技能与工作流数据读取正常。",
    "Recent audit events were read without exposing details.": "操作日志读取正常，未暴露敏感细节。"
  };
  return map[detail] ?? detail;
}

function localizeDashboardValue(value: string, lang: "zh" | "en"): string {
  if (lang !== "zh") return value;
  return value
    .replace(/\bpending\b/gi, "待处理")
    .replace(/\bapproved\b/gi, "已通过")
    .replace(/\blinked\b/gi, "已关联")
    .replace(/\brecent events\b/gi, "条近期记录");
}

function DashboardIcon({ name }: { name: "projects" | "workflow" | "skill" | "activity" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    projects: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 8h10M7 12h6M7 16h4" /></>,
    workflow: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><path d="M8 7.5 16 11M8 16.5 16 13" /></>,
    skill: <><path d="m12 3 2.4 5.1L20 9l-4 4.1.9 5.9-4.9-2.7L7.1 19l.9-5.9L4 9l5.6-.9L12 3Z" /></>,
    activity: <><path d="M4 12h3l2-6 4 12 2-6h5" /></>
  };
  return <svg className="dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function TrendChart({ trend }: { trend: DashboardOverview["trend"] }) {
  const { t } = useI18n();
  const maximum = Math.max(1, ...trend.flatMap((point) => [point.submitted, point.approved, point.rejected]));
  const points = (key: "submitted" | "approved" | "rejected") => trend.map((point, index) => `${(index / Math.max(1, trend.length - 1)) * 100},${88 - (point[key] / maximum) * 72}`).join(" ");
  const submittedPoints = points("submitted");
  const submittedArea = `0,100 ${submittedPoints} 100,100`;
  const approvedTotal = trend.reduce((sum, point) => sum + point.approved, 0);
  return <div className="trend-chart" role="img" aria-label={t.dashboard.chartAria}>
    <div className="trend-chart-meta"><span>{t.dashboard.chartMeta}</span><strong>{approvedTotal} <small>{t.dashboard.approved}</small></strong></div>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none"><defs><linearGradient id="submitted-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".26" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs><path className="chart-grid-line" d="M0 16H100M0 52H100M0 88H100" /><polygon className="submitted-area" points={submittedArea} /><polyline className="chart-line submitted-line" points={submittedPoints} /><polyline className="chart-line approved-line" points={points("approved")} /><polyline className="chart-line rejected-line" points={points("rejected")} /></svg>
    <div className="chart-axis">{trend.map((point) => <span key={point.date}>{point.date.slice(5)}</span>)}</div>
    <div className="chart-summary"><span>{trend.reduce((sum, point) => sum + point.submitted, 0)} {t.dashboard.submitted}</span><span>{approvedTotal} {t.dashboard.approved}</span><span>{trend.reduce((sum, point) => sum + point.rejected, 0)} {t.dashboard.rejected}</span></div>
  </div>;
}

function DistributionChart({ items }: { items: DashboardOverview["distributions"]["skill_categories"] }) {
  const { t } = useI18n();
  const total = items.reduce((sum, item) => sum + item.count, 0);
  let offset = 0;
  const palette = ["#17d4ff", "#8f7cff", "#20e3a2", "#f6a956"];
  const segments = items.map((item, index) => { const share = total === 0 ? 0 : item.count / total; const segment = { ...item, color: palette[index % palette.length], offset, share }; offset += share; return segment; });
  const style = { background: total === 0 ? "conic-gradient(var(--line) 0 100%)" : `conic-gradient(${segments.map((segment) => `${segment.color} ${segment.offset * 100}% ${(segment.offset + segment.share) * 100}%`).join(", ")})` };
  return <div className="distribution-chart"><div className="distribution-donut" style={style}><span>{total}</span><small>{t.dashboard.publishedSkills}</small></div><div className="distribution-list">{segments.map((item) => <div key={item.key}><i style={{ background: item.color }} /><span>{item.key}</span><b>{item.count}</b><small>{total === 0 ? 0 : Math.round(item.share * 100)}%</small></div>)}</div></div>;
}

export function AuthTokenForm() {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submitToken(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextToken = token.trim();
    setSaved(false);
    setMessage(null);
    if (nextToken === "") return;
    if (!/^hh_[A-Za-z0-9_-]+$/.test(nextToken)) {
      setMessage(t.token.invalidFormat);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/v1/projects?limit=1", {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + nextToken,
          "X-Request-Id": globalThis.crypto.randomUUID()
        }
      });
      if (!response.ok) {
        setMessage(
          response.status === 401 || response.status === 403
            ? t.token.rejected
            : t.token.httpError + response.status + "."
        );
        return;
      }
      window.sessionStorage.setItem("hunter-harness-token", nextToken);
      setToken("");
      setSaved(true);
      window.location.assign(window.location.pathname + window.location.search);
    } catch {
      setMessage(t.token.networkPolicy);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="token-form" onSubmit={(event) => { void submitToken(event); }}>
      <label htmlFor="api-token">{t.token.label}</label>
      <input
        id="api-token"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => {
          setToken(event.target.value);
          setSaved(false);
          setMessage(null);
        }}
        placeholder={t.token.placeholder}
      />
      <button type="submit" disabled={busy}>{busy ? t.token.checking : t.token.setButton}</button>
      {saved ? <span>{t.token.saved}</span> : null}
      {message === null ? null : <span>{message}</span>}
    </form>
  );
}
