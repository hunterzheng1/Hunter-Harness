"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  bootstrapSkills,
  compileClaudePreview,
  findSkill,
  profiles,
  type AdapterId,
  type ProfileId
} from "../lib/catalog";

function Label({ children }: { children: React.ReactNode }) {
  return <span className="status status-clear">{children}</span>;
}

export function WorkflowRegistry() {
  const [profileId, setProfileId] = useState<ProfileId>("general");
  const profile = profiles.find((item) => item.id === profileId) ?? profiles.find((item) => item.id === "general");
  if (profile === undefined) throw new Error("Bootstrap registry is missing the general profile.");
  const skills = bootstrapSkills.filter((item) => item.profiles.includes(profile.id));
  return (
    <section className="stack">
      <div className="page-heading"><div><p className="eyebrow">Bootstrap registry</p><h1>Harness Workflows</h1><p className="lede">Read-only bootstrap Skill IR. Publishing a canonical registry version requires a server registry API and review proposal.</p></div><Label>review-gated</Label></div>
      <div className="profile-grid">{profiles.map((item) => <button type="button" className={item.id === profile.id ? "profile-card selected" : "profile-card"} key={item.id} onClick={() => setProfileId(item.id)}><strong>{item.label}</strong><span>{item.description}</span><small>{bootstrapSkills.filter((skill) => skill.profiles.includes(item.id)).length} bootstrap skills</small></button>)}</div>
      <div className="panel workflow-panel"><div className="panel-title"><div><h2>{profile.label} recommended order</h2><p>{profile.description}</p></div><span>{skills.length} enabled</span></div>
        <ol className="workflow-list">{skills.map((item, index) => <li key={item.name}><span className="sequence">{String(index + 1).padStart(2, "0")}</span><div><Link href={`/skills/${item.name}`}><strong>{item.name}</strong></Link><p>{item.description}</p><div className="tag-row"><Label>{item.kind}</Label>{item.profiles.length < profiles.length ? <Label>profile-specific</Label> : null}<Label>human confirmation</Label></div></div></li>)}</ol>
      </div>
    </section>
  );
}

export function SkillRegistry() {
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState<ProfileId | "all">("all");
  const [adapter, setAdapter] = useState<AdapterId | "all">("all");
  const filtered = useMemo(() => bootstrapSkills.filter((item) =>
    item.name.includes(query.trim().toLowerCase()) &&
    (profile === "all" || item.profiles.includes(profile)) &&
    (adapter === "all" || item.adapters.includes(adapter))
  ), [adapter, profile, query]);
  return <section className="stack">
    <div className="page-heading"><div><p className="eyebrow">Bootstrap registry</p><h1>Skills</h1><p className="lede">Inspect the canonical bootstrap IR and adapter-safe output previews. This view never publishes directly.</p></div><span>{filtered.length} shown</span></div>
    <div className="filter-bar"><label>Search skills<input aria-label="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="harness-review" /></label><label>Profile<select aria-label="Profile" value={profile} onChange={(event) => setProfile(event.target.value as ProfileId | "all")}><option value="all">All profiles</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Adapter<select aria-label="Adapter" value={adapter} onChange={(event) => setAdapter(event.target.value as AdapterId | "all")}><option value="all">All adapters</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="generic">Generic</option><option value="mcp">MCP</option></select></label></div>
    <div className="skill-grid">{filtered.map((item) => <Link className="skill-card" href={`/skills/${item.name}`} key={item.name}><div><Label>{item.kind}</Label><strong>{item.name}</strong><p>{item.description}</p></div><div className="tag-row">{item.profiles.map((value) => <span key={value}>{value}</span>)}</div><small>v{item.version} · {item.adapters.length} adapters</small></Link>)}</div>
  </section>;
}

export function SkillDetail({ skillId }: { skillId: string }) {
  const skill = findSkill(skillId);
  if (skill === undefined) return <section className="empty-state">Unknown bootstrap Skill IR: {skillId}</section>;
  const ir = { name: skill.name, kind: skill.kind, description: skill.description, triggers: skill.triggers, inputs: skill.inputs, outputs: skill.outputs, forbidden_actions: skill.forbiddenActions, required_context: skill.requiredContext, profiles: skill.profiles, adapters: skill.adapters, version: skill.version };
  return <section className="stack">
    <div className="page-heading"><div><p className="eyebrow">Bootstrap Skill IR</p><h1>{skill.name}</h1><p className="lede">{skill.description}</p></div><Label>v{skill.version}</Label></div>
    <div className="metric-grid compact"><article className="metric"><strong>{skill.profiles.length}</strong><span>profiles</span></article><article className="metric"><strong>{skill.adapters.length}</strong><span>adapters</span></article><article className="metric"><strong>{skill.forbiddenActions.length}</strong><span>forbidden actions</span></article></div>
    <div className="detail-grid"><article className="panel"><div className="panel-title"><h2>Canonical Skill IR</h2></div><pre className="code-view">{JSON.stringify(ir, null, 2)}</pre></article><article className="panel"><div className="panel-title"><h2>Claude Code output preview</h2></div><pre className="code-view">{compileClaudePreview(skill)}</pre></article></div>
    <div className="detail-grid"><article className="panel"><div className="panel-title"><h2>Triggers and contract</h2></div><div className="definition-list"><strong>Triggers</strong><span>{skill.triggers.join(" · ")}</span><strong>Inputs</strong><span>{skill.inputs.join(" · ")}</span><strong>Outputs</strong><span>{skill.outputs.join(" · ")}</span><strong>Required context</strong><span>{skill.requiredContext.join(" · ")}</span></div></article><article className="panel"><div className="panel-title"><h2>Forbidden actions</h2></div><ul className="plain-list">{skill.forbiddenActions.map((action) => <li key={action}>{action}</li>)}</ul></article></div>
  </section>;
}
