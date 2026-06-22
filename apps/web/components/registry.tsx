"use client";

import type {
  RegistryAgent,
  RegistrySkillDetail,
  RegistrySkillProposal,
  RegistrySkillVersion,
  RegistryTag,
  RegistryWorkflow,
  RegistryWorkflowMutation,
  SkillIr
} from "@hunter-harness/contracts";
import JSZip from "jszip";
import Link from "next/link";
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from "react";
import { parse as parseYaml } from "yaml";

import { ApiClientError, browserApi, type HunterApi } from "../lib/api";
import { mockApi } from "../lib/mock-api";

function apiError(error: unknown): string {
  if (process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" && error instanceof Error) {
    return "Explicit demo data failed: " + error.message;
  }
  if (error instanceof ApiClientError && error.status === 401) {
    return "需要认证。请在设置中填写 API Token；控制台不会使用演示数据代替真实状态。";
  }
  if (error instanceof ApiClientError) return `请求失败（${error.code}）。未显示服务端敏感详情。`;
  return "操作失败，请检查网络和服务端状态。";
}

function required<K extends keyof HunterApi>(api: HunterApi, key: K): NonNullable<HunterApi[K]> {
  const method = api[key];
  if (typeof method !== "function") throw new Error(`API capability ${String(key)} is unavailable`);
  return method.bind(api) as NonNullable<HunterApi[K]>;
}

function useApi(value?: HunterApi): HunterApi {
  return useMemo(() => value ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [value]);
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value.replaceAll("_", "-")}`}>{value.replaceAll("_", " ")}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

async function parseSkillFile(file: File): Promise<SkillIr> {
  let name = file.name;
  let content: string;
  if (name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = Object.values(zip.files).find((item) =>
      !item.dir && /(^|\/)(skill\.ya?ml|skill\.json|hunter-skill-ir\.json)$/i.test(item.name) && !item.name.includes("..")
    );
    if (entry === undefined) throw new Error("ZIP 中未找到 Skill IR");
    name = entry.name;
    content = await entry.async("text");
  } else {
    content = await file.text();
  }
  const candidate = name.toLowerCase().endsWith(".json") ? JSON.parse(content) : parseYaml(content);
  return candidate as SkillIr;
}

export function SkillRegistry({ api: apiValue }: { api?: HunterApi }) {
  const api = useApi(apiValue);
  const [skills, setSkills] = useState<RegistrySkillDetail[] | null>(null);
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [workflows, setWorkflows] = useState<RegistryWorkflow[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [profile, setProfile] = useState("");
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tagSlug, setTagSlug] = useState("");
  const [tagLabel, setTagLabel] = useState("");
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [upload, setUpload] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [nextSkills, nextTags, nextWorkflows] = await Promise.all([
        required(api, "listSkills")(),
        required(api, "listTags")(),
        required(api, "listWorkflows")()
      ]);
      setSkills(nextSkills);
      setTags(nextTags);
      setWorkflows(nextWorkflows);
      setError(null);
    } catch (reason) {
      setError(apiError(reason));
    }
  }

  useEffect(() => { void refresh(); }, [api]);

  const profiles = [...new Set((skills ?? []).flatMap((skill) =>
    Object.entries(skill.ir?.profiles ?? {}).filter(([, value]) => value.enabled).map(([key]) => key)
  ))].sort();
  const filtered = (skills ?? []).filter((skill) => {
    const needle = search.trim().toLowerCase();
    return (needle === "" || `${skill.name} ${skill.slug} ${skill.description}`.toLowerCase().includes(needle)) &&
      (category === "" || skill.category === category) &&
      (tagFilter === "" || skill.tags.includes(tagFilter)) &&
      (profile === "" || skill.ir?.profiles[profile]?.enabled === true) &&
      (agent === "" || skill.adapters.includes(agent as RegistryAgent)) &&
      (status === "" || skill.status === status) &&
      (version.trim() === "" || skill.latest_version === version.trim());
  });

  async function createTag(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await required(api, "createTag")(tagSlug, tagLabel);
      setTagSlug(""); setTagLabel(""); setMessage("标签已直接保存并记录审计。");
      await refresh();
    } catch (reason) { setError(apiError(reason)); }
  }

  async function updateTag(tag: RegistryTag, input: { label?: string; active?: boolean }): Promise<void> {
    try { await required(api, "updateTag")(tag.tag_id, { revision: tag.revision, ...input }); setMessage("标签元数据已直接更新并写入审计。"); await refresh(); }
    catch (reason) { setError(apiError(reason)); }
  }

  async function mergeTag(tag: RegistryTag): Promise<void> {
    const target = mergeTargets[tag.tag_id];
    if (target === undefined || target === "") return;
    try { await required(api, "mergeTag")(tag.tag_id, target, tag.revision); setMessage("标签已合并，Skill 绑定已迁移并写入审计。"); await refresh(); }
    catch (reason) { setError(apiError(reason)); }
  }

  async function submitUpload(): Promise<void> {
    if (upload === null) return;
    try {
      const ir = await parseSkillFile(upload);
      const proposal = await required(api, "createSkillProposal")(ir, "claude-code");
      setMessage(`已创建待审核提案 ${proposal.proposal_id}；已发布版本未改变。`);
      setUpload(null);
    } catch (reason) { setError(apiError(reason)); }
  }

  if (error !== null && skills === null) return <Empty>{error}</Empty>;
  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero">
        <div>
          <p className="eyebrow">Canonical Registry</p>
          <h1>Skill Center</h1>
          <p className="lede">浏览、验证、下载和提交 Skill IR。内容与版本发布始终经过人工审核。</p>
        </div>
        <div className="hero-actions"><Status value="governed" /><span>{skills?.length ?? 0} published</span></div>
      </header>

      <div className="registry-toolbar registry-toolbar-expanded panel">
        <label className="search-wide">搜索 Skill / Search skills<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="name, slug, description" /></label>
        <label>分类 / Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部</option><option value="workflow">Workflow</option><option value="governance">Governance</option><option value="tooling">Tooling</option><option value="migration">Migration</option></select></label>
        <label>标签 / Tag<select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">全部</option>{tags.filter((tag) => tag.active).map((tag) => <option value={tag.slug} key={tag.tag_id}>{tag.label}</option>)}</select></label>
        <label>Profile<select value={profile} onChange={(event) => setProfile(event.target.value)}><option value="">全部</option>{profiles.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label>Agent<select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="">全部</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="generic">Generic</option><option value="mcp">MCP</option></select></label>
        <label>状态 / Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部</option><option value="published">Published</option><option value="pending_review">Pending review</option><option value="draft">Draft</option><option value="rejected">Rejected</option><option value="deprecated">Deprecated</option></select></label>
        <label>版本 / Version<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0.0" /></label>
      </div>

      <div className="hub-grid">
        <div className="panel registry-list">
          <div className="panel-title"><h2>已发布 Skill</h2><span>{filtered.length}</span></div>
          {skills === null ? <div className="skeleton-block" /> : filtered.length === 0 ? <Empty>没有匹配的 Skill。</Empty> : filtered.map((skill) => {
            const usageCount = workflows.filter((workflow) => workflow.skill_slugs.includes(skill.slug)).length;
            return (
              <Link className="skill-row" href={`/skills/${skill.slug}`} key={skill.skill_id}>
                <div><strong>{skill.name}</strong><p>{skill.description}</p><div className="tag-row"><Status value={skill.category} />{skill.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div></div>
                <div className="skill-meta"><code>v{skill.latest_version}</code><span>{skill.adapters.length} adapters</span><span>{usageCount} {usageCount === 1 ? "workflow" : "workflows"}</span><span>updated {skill.updated_at.slice(0, 10)}</span><Status value="validated" /><Status value={skill.status} /></div>
              </Link>
            );
          })}
        </div>
        <aside className="hub-rail">
          <form className="panel compact-form" onSubmit={(event) => void createTag(event)}>
            <div className="panel-title"><h2>标签管理</h2><span>直接生效</span></div>
            <label>Slug<input required value={tagSlug} onChange={(event) => setTagSlug(event.target.value)} placeholder="security" /></label>
            <label>显示名称<input required value={tagLabel} onChange={(event) => setTagLabel(event.target.value)} placeholder="Security" /></label>
            <button type="submit">创建标签</button>
            <div className="tag-admin-list">{tags.map((tag) => <div key={tag.tag_id}>
              <input aria-label={`重命名 ${tag.slug}`} defaultValue={tag.label} onBlur={(event) => event.target.value !== tag.label && void updateTag(tag, { label: event.target.value })} />
              <Status value={tag.active ? "active" : "inactive"} />
              {tag.active ? <button className="secondary" type="button" onClick={() => void updateTag(tag, { active: false })}>停用</button> : null}
              {tag.active ? <><select aria-label={`合并 ${tag.slug}`} value={mergeTargets[tag.tag_id] ?? ""} onChange={(event) => setMergeTargets({ ...mergeTargets, [tag.tag_id]: event.target.value })}><option value="">合并到…</option>{tags.filter((target) => target.active && target.tag_id !== tag.tag_id).map((target) => <option value={target.tag_id} key={target.tag_id}>{target.label}</option>)}</select><button type="button" className="secondary" onClick={() => void mergeTag(tag)}>合并</button></> : null}
            </div>)}</div>
          </form>
          <div className="panel compact-form">
            <div className="panel-title"><h2>上传候选 Skill</h2><Status value="review-required" /></div>
            <p>接受 ZIP、YAML 或 JSON；上传仅创建 proposal，不会直接发布。</p>
            <label className="file-drop">选择文件<input type="file" accept=".zip,.yaml,.yml,.json" onChange={(event: ChangeEvent<HTMLInputElement>) => setUpload(event.target.files?.[0] ?? null)} /></label>
            <button disabled={upload === null} onClick={() => void submitUpload()}>校验并提交审核</button>
          </div>
        </aside>
      </div>
      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}

export function SkillDetail({ api: apiValue, skillId }: { api?: HunterApi; skillId: string }) {
  const api = useApi(apiValue);
  const [skill, setSkill] = useState<RegistrySkillDetail | null>(null);
  const [versions, setVersions] = useState<RegistrySkillVersion[]>([]);
  const [proposals, setProposals] = useState<RegistrySkillProposal[]>([]);
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [agent, setAgent] = useState<RegistryAgent>("claude-code");
  const [selectedTag, setSelectedTag] = useState("");
  const [draft, setDraft] = useState("");
  const [adapterPreview, setAdapterPreview] = useState<{ path: string; content: string; sourceIrHash: string; compilerVersion: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [detail, history, pending, allTags] = await Promise.all([
        required(api, "getSkill")(skillId), required(api, "listSkillVersions")(skillId),
        required(api, "listSkillProposals")(), required(api, "listTags")()
      ]);
      setSkill(detail); setVersions(history); setTags(allTags);
      setProposals(pending.filter((proposal) => proposal.skill_slug === skillId));
      setDraft(JSON.stringify(detail.ir, null, 2)); setError(null);
    } catch (reason) { setError(apiError(reason)); }
  }

  useEffect(() => {
    const stored = globalThis.localStorage?.getItem("hunter-harness-default-agent") as RegistryAgent | null;
    if (stored === "claude-code" || stored === "codex" || stored === "generic" || stored === "mcp") setAgent(stored);
    void refresh();
  }, [api, skillId]);

  useEffect(() => {
    let active = true;
    setAdapterPreview(null);
    if (api.getSkillAdapterPreview === undefined) return () => { active = false; };
    void api.getSkillAdapterPreview(skillId, agent)
      .then((value) => { if (active) setAdapterPreview(value); })
      .catch((reason: unknown) => {
        if (active && agent === "claude-code") setError(apiError(reason));
      });
    return () => { active = false; };
  }, [api, skillId, agent]);
  const command = `npx @hunter-harness/skill-cli install ${skillId} --agent ${agent}`;
  async function copyCommand(): Promise<void> {
    await navigator.clipboard.writeText(command); setMessage("安装命令已复制。");
  }
  async function download(): Promise<void> {
    try {
      const artifact = await required(api, "downloadSkillArtifact")(skillId, agent);
      const url = URL.createObjectURL(artifact.blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; anchor.click();
      URL.revokeObjectURL(url); setMessage(`已下载并由服务端记录审计：${artifact.hash.slice(0, 20)}…`);
    } catch (reason) { setError(apiError(reason)); }
  }
  async function submitDraft(): Promise<void> {
    try {
      const proposal = await required(api, "createSkillProposal")(JSON.parse(draft) as SkillIr, "claude-code");
      setMessage(`已创建 ${proposal.proposal_id}，等待人工审核。`); await refresh();
    } catch (reason) { setError(apiError(reason)); }
  }
  async function review(proposalId: string, decision: "approve" | "reject"): Promise<void> {
    try { await required(api, "reviewSkillProposal")(proposalId, decision, "Owner review from Web Console"); setMessage(`已${decision === "approve" ? "批准并发布" : "拒绝"} ${proposalId}`); await refresh(); }
    catch (reason) { setError(apiError(reason)); }
  }
  async function bindTag(): Promise<void> {
    if (selectedTag === "") return;
    try { setSkill(await required(api, "bindSkillTag")(skillId, selectedTag)); setMessage("标签已直接保存并记录审计。"); }
    catch (reason) { setError(apiError(reason)); }
  }
  async function unbindTag(slug: string): Promise<void> {
    const tag = tags.find((item) => item.slug === slug);
    if (tag === undefined) {
      setError("标签元数据缺失，无法安全移除。");
      return;
    }
    try {
      setSkill(await required(api, "bindSkillTag")(skillId, tag.tag_id, true));
      setMessage("标签已直接移除并记录审计。");
    } catch (reason) { setError(apiError(reason)); }
  }

  if (error !== null && skill === null) return <Empty>{error}</Empty>;
  if (skill === null) return <Empty>正在加载 Canonical Skill…</Empty>;
  const previous = versions[1];
  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero">
        <div><p className="eyebrow">Canonical Skill IR</p><h1>{skill.name}</h1><p className="lede">{skill.description}</p><div className="tag-row"><Status value={skill.category} />{skill.tags.map((tag) => <button type="button" className="tag tag-remove" aria-label={`移除标签 ${tag}`} onClick={() => void unbindTag(tag)} key={tag}>{tag}<span aria-hidden="true">×</span></button>)}</div></div>
        <div className="skill-meta"><Status value={skill.status} /><code>v{skill.latest_version}</code></div>
      </header>

      <div className="command-panel panel">
        <label>目标 Agent<select value={agent} onChange={(event) => { const value = event.target.value as RegistryAgent; setAgent(value); localStorage.setItem("hunter-harness-default-agent", value); }}><option value="claude-code">Claude Code</option><option value="codex">Codex（仅契约）</option><option value="generic">Generic（仅契约）</option><option value="mcp">MCP（仅契约）</option></select></label>
        <code>{command}</code>
        <button onClick={() => void copyCommand()}>复制命令</button>
        <button className="secondary" disabled={agent !== "claude-code"} onClick={() => void download()}>下载 ZIP</button>
      </div>

      <article className="panel adapter-preview">
        <div className="panel-title"><h2>Published adapter output</h2><span>{adapterPreview?.path ?? `${agent} contract only`}</span></div>
        {adapterPreview === null
          ? <Empty>{agent === "claude-code" ? "Loading verified adapter output…" : "This adapter is contract-only in MVP and is not offered as one-click install."}</Empty>
          : <><pre className="code-view">{adapterPreview.content}</pre><div className="artifact-proof"><code>{adapterPreview.sourceIrHash}</code><span>compiler {adapterPreview.compilerVersion}</span></div></>}
      </article>
      <div className="detail-grid">
        <article className="panel"><div className="panel-title"><h2>Canonical Skill IR</h2><span>review required</span></div><pre className="code-view">{JSON.stringify(skill.ir, null, 2)}</pre></article>
        <article className="panel"><div className="panel-title"><h2>契约与安全边界</h2></div><dl className="definition-list"><dt>Triggers</dt><dd>{skill.ir?.triggers.join(" · ")}</dd><dt>Inputs</dt><dd>{skill.ir?.inputs.join(" · ") || "None"}</dd><dt>Outputs</dt><dd>{skill.ir?.outputs.join(" · ")}</dd><dt>Forbidden actions</dt><dd>{skill.ir?.forbidden_actions.join(" · ") || "None"}</dd><dt>Required context</dt><dd>{skill.ir?.required_context.join(" · ") || "None"}</dd><dt>Provenance</dt><dd>{skill.ir?.source_provenance ?? "Registry-authored; external license metadata not supplied."}</dd></dl></article>
      </div>

      <div className="detail-grid">
        <article className="panel"><div className="panel-title"><h2>版本历史</h2><span>{versions.length}</span></div>{versions.map((version) => <div className="version-row" key={version.version}><div><strong>v{version.version}</strong><code>{version.source_proposal_id ?? "bootstrap"}</code></div><span>{new Date(version.created_at).toLocaleString()}</span></div>)}</article>
        <article className="panel"><div className="panel-title"><h2>Version Diff</h2><span>{previous === undefined ? "first version" : `${previous.version} → ${skill.latest_version}`}</span></div><div className="diff-panel"><pre>{previous === undefined ? "No previous version." : JSON.stringify(previous.ir, null, 2)}</pre><pre>{JSON.stringify(skill.ir, null, 2)}</pre></div></article>
      </div>

      <article className="panel compact-form"><div className="panel-title"><h2>标签绑定</h2><span>无需审核</span></div><div className="inline-form"><select aria-label="选择标签" value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}><option value="">选择标签</option>{tags.filter((tag) => tag.active && !skill.tags.includes(tag.slug)).map((tag) => <option value={tag.tag_id} key={tag.tag_id}>{tag.label}</option>)}</select><button onClick={() => void bindTag()}>添加标签</button></div></article>

      <article className="panel"><div className="panel-title"><h2>创建内容变更 Proposal</h2><Status value="review-required" /></div><textarea className="ir-editor" aria-label="Skill IR draft" value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="actions"><button onClick={() => void submitDraft()}>校验并提交</button></div></article>

      <article className="panel"><div className="panel-title"><h2>审核记录</h2><span>{proposals.length}</span></div>{proposals.length === 0 ? <Empty>没有与此 Skill 关联的 proposal。</Empty> : proposals.map((proposal) => <div className="proposal-card" key={proposal.proposal_id}><div><strong>{proposal.proposal_id}</strong><code>v{proposal.proposed_ir.version}</code><small>schema {proposal.validation.schema_valid ? "valid" : "invalid"} · sensitive findings {proposal.validation.sensitive_findings} · Claude compile {proposal.validation.claude_compilable ? "passed" : "failed"}</small></div><div><Status value={proposal.status} />{proposal.status === "pending_review" ? <><button onClick={() => void review(proposal.proposal_id, "approve")}>批准</button><button className="secondary" onClick={() => void review(proposal.proposal_id, "reject")}>拒绝</button></> : null}</div></div>)}</article>
      {message === null ? null : <div className="notice success">{message}</div>}{error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}

const blankWorkflow: RegistryWorkflowMutation = {
  key: "", name: "", description: "", profile: "general", default_agent: "claude-code",
  enabled: true, skill_slugs: []
};

export function WorkflowRegistry({ api: apiValue }: { api?: HunterApi }) {
  const api = useApi(apiValue);
  const [workflows, setWorkflows] = useState<RegistryWorkflow[] | null>(null);
  const [skills, setSkills] = useState<RegistrySkillDetail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<RegistryWorkflowMutation>(blankWorkflow);
  const [revision, setRevision] = useState<number | null>(null);
  const [workflowQuery, setWorkflowQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = workflows?.find((item) => item.workflow_id === selectedId) ?? null;
  const workflowNeedle = workflowQuery.trim().toLowerCase();
  const filteredWorkflows = (workflows ?? []).filter((workflow) => workflowNeedle === "" ||
    `${workflow.name} ${workflow.key} ${workflow.profile}`.toLowerCase().includes(workflowNeedle));
  const skillNeedle = skillQuery.trim().toLowerCase();
  const filteredLibrarySkills = skills.filter((skill) => skillNeedle === "" ||
    `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(skillNeedle));

  async function refresh(preferId?: string): Promise<void> {
    try {
      const [nextWorkflows, nextSkills] = await Promise.all([required(api, "listWorkflows")(), required(api, "listSkills")()]);
      setWorkflows(nextWorkflows); setSkills(nextSkills); setError(null);
      const id = preferId ?? selectedId ?? nextWorkflows[0]?.workflow_id ?? null;
      setSelectedId(id);
      const value = nextWorkflows.find((item) => item.workflow_id === id);
      if (value !== undefined) {
        setForm({ key: value.key, name: value.name, description: value.description, profile: value.profile, default_agent: value.default_agent, enabled: value.enabled, skill_slugs: value.skill_slugs });
        setRevision(value.revision);
      }
    } catch (reason) { setError(apiError(reason)); }
  }
  useEffect(() => { void refresh(); }, [api]);

  function edit(workflow: RegistryWorkflow): void {
    setSelectedId(workflow.workflow_id); setRevision(workflow.revision);
    setForm({ key: workflow.key, name: workflow.name, description: workflow.description, profile: workflow.profile, default_agent: workflow.default_agent, enabled: workflow.enabled, skill_slugs: workflow.skill_slugs });
  }
  function move(index: number, direction: -1 | 1): void {
    const next = [...form.skill_slugs]; const target = index + direction;
    const currentSkill = next[index]; const targetSkill = next[target];
    if (target < 0 || target >= next.length || currentSkill === undefined || targetSkill === undefined) return;
    next[index] = targetSkill; next[target] = currentSkill;
    setForm({ ...form, skill_slugs: next });
  }
  async function save(): Promise<void> {
    try {
      let saved: RegistryWorkflow;
      if (revision === null) {
        saved = await required(api, "createWorkflow")(form);
      } else {
        if (selectedId === null) throw new Error("selected Workflow is missing");
        saved = await required(api, "updateWorkflow")(selectedId, { ...form, revision });
      }
      await refresh(saved.workflow_id);
    } catch (reason) { setError(apiError(reason)); }
  }
  async function remove(): Promise<void> {
    if (selectedId === null || revision === null) return;
    try { await required(api, "deleteWorkflow")(selectedId, revision); setSelectedId(null); setRevision(null); setForm(blankWorkflow); await refresh(); }
    catch (reason) { setError(apiError(reason)); }
  }

  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero"><div><p className="eyebrow">Direct metadata governance</p><h1>Workflows</h1><p className="lede">维护项目按顺序使用哪些已发布 Skill。它不是 DAG 或自动执行器。</p></div><button onClick={() => { setSelectedId(null); setRevision(null); setForm(blankWorkflow); }}>新建 Workflow / New workflow</button></header>
      <div className="workflow-workbench">
        <div className="panel workflow-index"><div className="panel-title"><h2>Workflow Profiles</h2><span>{filteredWorkflows.length}</span></div><label className="rail-search">搜索 Workflow / Search workflows<input value={workflowQuery} onChange={(event) => setWorkflowQuery(event.target.value)} placeholder="name, key, profile" /></label>{workflows === null ? <div className="skeleton-block" /> : workflows.length === 0 ? <Empty>尚无 Workflow / No workflows</Empty> : filteredWorkflows.length === 0 ? <Empty>没有匹配的 Workflow。</Empty> : filteredWorkflows.map((workflow) => <button className={workflow.workflow_id === selectedId ? "selected" : ""} key={workflow.workflow_id} onClick={() => edit(workflow)}><strong>{workflow.name}</strong><span>{workflow.profile} · {workflow.skill_slugs.length} skills</span><Status value={workflow.enabled ? "active" : "archived"} /></button>)}</div>
        <div className="panel workflow-editor compact-form">
          <div className="panel-title"><h2>{selected === null ? "新建 Workflow" : "编辑 Workflow"}</h2><span>{revision === null ? "new" : `revision ${revision}`}</span></div>
          <div className="form-grid"><label>名称 / Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>标识 / Key<input value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} /></label><label className="span-2">描述 / Description<textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><label>Profile<input value={form.profile} onChange={(event) => setForm({ ...form, profile: event.target.value })} /></label><label>默认 Agent<select value={form.default_agent} onChange={(event) => setForm({ ...form, default_agent: event.target.value as RegistryAgent })}><option value="claude-code">Claude Code</option></select></label></div>
          <div className="panel-title"><h3>有序 Skill Binding</h3><span>直接保存 + 审计</span></div>
          <ol className="binding-list">{form.skill_slugs.map((slug, index) => <li key={slug}><span className="sequence">{String(index + 1).padStart(2, "0")}</span><strong>{slug}</strong><div><button className="icon-button" aria-label={`上移 ${slug}`} onClick={() => move(index, -1)}>↑</button><button className="icon-button" aria-label={`下移 ${slug}`} onClick={() => move(index, 1)}>↓</button><button className="icon-button danger" aria-label={`移除 ${slug}`} onClick={() => setForm({ ...form, skill_slugs: form.skill_slugs.filter((item) => item !== slug) })}>×</button></div></li>)}</ol>
          <label>添加已发布 Skill<select value="" onChange={(event) => event.target.value !== "" && setForm({ ...form, skill_slugs: [...form.skill_slugs, event.target.value] })}><option value="">选择 Skill</option>{skills.filter((skill) => !form.skill_slugs.includes(skill.slug) && skill.adapters.includes(form.default_agent) && skill.ir?.profiles[form.profile]?.enabled).map((skill) => <option value={skill.slug} key={skill.skill_id}>{skill.name}</option>)}</select></label>
          <div className="actions"><button disabled={!form.name || !form.key || !form.description} onClick={() => void save()}>保存 / Save</button>{revision === null ? null : <button className="secondary danger" onClick={() => void remove()}>归档 / 删除</button>}</div>
        </div>
        <div className="panel skill-library"><div className="panel-title"><h2>可用 Skill</h2><span>{filteredLibrarySkills.length}</span></div><label className="rail-search">搜索可用 Skill / Search available skills<input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="name, description, category" /></label>{filteredLibrarySkills.length === 0 ? <Empty>没有匹配的已发布 Skill。</Empty> : filteredLibrarySkills.map((skill) => <div className="library-item" key={skill.skill_id}><div><strong>{skill.name}</strong><p>{skill.description}</p></div><Status value={skill.category} /></div>)}</div>
      </div>
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
