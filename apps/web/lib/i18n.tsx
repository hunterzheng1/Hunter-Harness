"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type Language = "zh" | "en";

// ── Translation dictionaries ─────────────────────────────────

const zh = {
  brand: "Hunter Harness",
  brandSub: "治理控制台",
  nav: {
    overview: "总览",
    projects: "项目",
    workflows: "工作流",
    skills: "技能",
    reviewQueue: "审核队列",
    artifacts: "制品",
  },
  token: {
    label: "会话 API 令牌",
    placeholder: "仅存储在浏览器标签页",
    setButton: "设置令牌",
    checking: "验证中…",
    saved: "已保存",
  },
  dashboard: {
    eyebrow: "治理总览",
    title: "本地开发，审核发布。",
    registeredProjects: "已注册项目",
    pendingReview: "待审核",
    pendingReviews: "项待审核",
    approvedProposals: "已批准提案",
    projectsPanel: "项目",
    openRegistry: "打开注册表",
    noProjects: "暂无已注册的项目。",
    noVersion: "暂无已发布版本",
    loading: "正在加载治理总览…",
  },
  projects: {
    eyebrow: "注册表",
    title: "项目",
    noProjects: "暂无已注册的项目。",
    loading: "正在加载项目注册表…",
    table: {
      project: "项目",
      role: "角色",
      version: "版本",
      artifact: "制品",
      none: "—",
    },
  },
  reviewQueue: {
    eyebrow: "人工审核关卡",
    title: "审核队列",
    waiting: "等待中",
    clear: "审核队列为空。",
    loading: "正在加载审核队列…",
    changes: "项变更",
  },
  artifacts: {
    eyebrow: "已批准发布",
    title: "制品历史",
    published: "已发布",
    noArtifacts: "暂无已发布的制品。",
    loading: "正在加载制品历史…",
    table: {
      artifact: "制品",
      project: "项目",
      version: "版本",
      changes: "变更数",
      proposal: "提案",
    },
  },
  workflows: {
    eyebrow: "引导注册表",
    title: "工作流",
    description: "只读引导技能 IR。发布规范注册表版本需要服务端 API 和提案审核。",
    reviewGated: "审核管控",
    recommendedOrder: "推荐顺序",
    enabled: "已启用",
    profileSpecific: "特定配置",
    humanConfirmation: "人工确认",
  },
  skills: {
    eyebrow: "引导注册表",
    title: "技能",
    description: "查看规范引导 IR 和适配器安全输出预览。此视图不直接发布。",
    shown: "已显示",
    searchPlaceholder: "搜索技能",
    profile: "配置",
    allProfiles: "所有配置",
    adapter: "适配器",
    allAdapters: "所有适配器",
    unknownSkill: "未找到引导技能 IR:",
  },
  proposal: {
    eyebrow: "提案",
    changedItems: "变更项",
    bytes: "字节",
    reviewEvents: "审核事件",
    redactedNotice: "制品内容在 Web 控制台中被隐去。仅显示元数据、路径、哈希、大小和风险证据。",
    changes: "变更",
    reviewRationale: "审核理由",
    placeholder: "可选，隐去的理由",
    approve: "批准",
    reject: "拒绝",
    split: "拆分",
    approvedAs: "已批准为",
    splitInto: "拆分为",
    proposals: "个提案",
    decisionRecorded: "决策已记录：",
    loading: "正在加载提案…",
  },
  error: {
    authRequired: "需要认证。请为此浏览器会话添加有效 API 令牌。",
    networkError: "治理请求失败 (NETWORK_ERROR)。",
    genericError: "治理请求失败。未显示敏感细节。",
  },
  langSwitch: "English",
  settings: {
    title: "设置",
    language: "语言",
    theme: "主题",
    light: "浅色",
    dark: "深色",
    apiToken: "API 令牌",
  },
};

const en: typeof zh = {
  brand: "Hunter Harness",
  brandSub: "Governance Console",
  nav: {
    overview: "Overview",
    projects: "Projects",
    workflows: "Workflows",
    skills: "Skills",
    reviewQueue: "Review Queue",
    artifacts: "Artifacts",
  },
  token: {
    label: "Session API Token",
    placeholder: "Stored in this tab only",
    setButton: "Set Token",
    checking: "Checking…",
    saved: "Saved",
  },
  dashboard: {
    eyebrow: "Governance Overview",
    title: "Local work, reviewed releases.",
    registeredProjects: "registered projects",
    pendingReview: "pending review",
    pendingReviews: "pending reviews",
    approvedProposals: "approved proposals",
    projectsPanel: "Projects",
    openRegistry: "Open registry",
    noProjects: "No projects have been registered.",
    noVersion: "No published version",
    loading: "Loading governance overview…",
  },
  projects: {
    eyebrow: "Registry",
    title: "Projects",
    noProjects: "No projects have been registered.",
    loading: "Loading project registry…",
    table: {
      project: "Project",
      role: "Role",
      version: "Version",
      artifact: "Artifact",
      none: "—",
    },
  },
  reviewQueue: {
    eyebrow: "Human Review Gate",
    title: "Review Queue",
    waiting: "waiting",
    clear: "The review queue is clear.",
    loading: "Loading review queue…",
    changes: "changes",
  },
  artifacts: {
    eyebrow: "Approved Releases",
    title: "Artifact History",
    published: "published",
    noArtifacts: "No artifacts have been published.",
    loading: "Loading artifact history…",
    table: {
      artifact: "Artifact",
      project: "Project",
      version: "Version",
      changes: "Changes",
      proposal: "Proposal",
    },
  },
  workflows: {
    eyebrow: "Bootstrap Registry",
    title: "Workflows",
    description:
      "Read-only bootstrap Skill IR. Publishing a canonical registry version requires a server registry API and review proposal.",
    reviewGated: "review-gated",
    recommendedOrder: "recommended order",
    enabled: "enabled",
    profileSpecific: "profile-specific",
    humanConfirmation: "human confirmation",
  },
  skills: {
    eyebrow: "Bootstrap Registry",
    title: "Skills",
    description:
      "Inspect the canonical bootstrap IR and adapter-safe output previews. This view never publishes directly.",
    shown: "shown",
    searchPlaceholder: "Search skills",
    profile: "Profile",
    allProfiles: "All profiles",
    adapter: "Adapter",
    allAdapters: "All adapters",
    unknownSkill: "Unknown bootstrap Skill IR:",
  },
  proposal: {
    eyebrow: "Proposal",
    changedItems: "changed items",
    bytes: "bytes",
    reviewEvents: "review events",
    redactedNotice:
      "Artifact content is redacted in the Web Console. Review metadata, paths, hashes, size, and risk evidence only.",
    changes: "Changes",
    reviewRationale: "Review rationale",
    placeholder: "Optional, redacted rationale",
    approve: "Approve",
    reject: "Reject",
    split: "Split",
    approvedAs: "Approved as",
    splitInto: "Split into",
    proposals: " proposals",
    decisionRecorded: "Decision recorded: ",
    loading: "Loading proposal…",
  },
  error: {
    authRequired:
      "Authentication required. Add a valid API token to this browser session.",
    networkError:
      "Governance request failed (NETWORK_ERROR).",
    genericError:
      "Governance request failed. No sensitive details were displayed.",
  },
  langSwitch: "中文",
  settings: {
    title: "Settings",
    language: "Language",
    theme: "Theme",
    light: "Light",
    dark: "Dark",
    apiToken: "API Token",
  },
};

const dictionaries = { zh, en };

// ── Context ─────────────────────────────────────────────────

interface I18nContextValue {
  lang: Language;
  t: typeof zh;
  toggleLang: () => void;
}

const I18nContext = createContext<I18nContextValue>({
  lang: "zh",
  t: zh,
  toggleLang: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>("zh");
  const toggleLang = () => setLang((prev) => (prev === "zh" ? "en" : "zh"));
  const t = dictionaries[lang];
  return (
    <I18nContext.Provider value={{ lang, t, toggleLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}