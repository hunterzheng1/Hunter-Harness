"use client";

import { useEffect, useMemo, useState } from "react";

import type { WorkflowPackage, WorkflowPackageDraftState, WorkflowPackageVersion } from "@hunter-harness/contracts";

import { browserApi, buildUploadFormData, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { apiError, required } from "./skill-shared";

// 工作流中心（T17）：workflow package 上传 ZIP + 列表 + 草稿 + 检查 + 发布 + 版本记录。
// 与清单 WorkflowList 并存（设计 §6：清单 workflow 与 package 本期并存），不替换 /workflows 的清单管理。
// 标签硬编码中文：workflow package 是新概念，i18n key 未定义（MVP，后续 i18n 切片补 t.workflowPackage.*）。
function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

export function WorkflowCenter({ api: apiValue }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useMemo(() => apiValue ?? resolveApi(), [apiValue]);
  const [packages, setPackages] = useState<WorkflowPackage[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowPackageDraftState | null>(null);
  const [versions, setVersions] = useState<WorkflowPackageVersion[]>([]);
  const [upload, setUpload] = useState<File[] | null>(null);
  const [publishVersion, setPublishVersion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const items = await required(api, "listWorkflowPackages")();
      setPackages(items);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); }, [api]);

  async function submitUpload(): Promise<void> {
    if (upload === null || upload.length === 0) return;
    const files = upload;
    setUpload(null);
    try {
      const d = await required(api, "uploadWorkflowPackage")(buildUploadFormData(files));
      setDraft(d);
      setSelectedKey(d.key);
      setMessage("工作流包草稿已上传：" + d.key);
      void refresh();
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function selectPackage(key: string): Promise<void> {
    setSelectedKey(key);
    setDraft(null);
    setVersions([]);
    try {
      const vers = await required(api, "listWorkflowPackageVersions")(key);
      setVersions(vers);
      try {
        const d = await required(api, "getWorkflowPackageDraft")(key);
        setDraft(d);
      } catch {
        // 已发布无草稿属正常状态，不报错
      }
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function runChecks(): Promise<void> {
    if (selectedKey === null) return;
    try {
      const result = await required(api, "runWorkflowPackageChecks")(selectedKey);
      setDraft((cur) => cur === null ? cur : { ...cur, checks: result });
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function publish(): Promise<void> {
    if (selectedKey === null || publishVersion === "") return;
    try {
      await required(api, "publishWorkflowPackage")(selectedKey, { version: publishVersion });
      setPublishVersion("");
      setMessage("已发布版本 " + publishVersion);
      void selectPackage(selectedKey);
      void refresh();
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  return (
    <section className="panel panel-themed">
      <h2>工作流包管理</h2>
      <div className="compact-form panel-upload">
        <input type="file" multiple accept=".zip" onChange={(e) => setUpload(Array.from(e.target.files ?? []))} />
        <button type="button" onClick={() => void submitUpload()} disabled={upload === null}>上传工作流包</button>
      </div>
      {message === null ? null : <div className="notice">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
      <ul className="card-list">
        {(packages ?? []).map((p) => (
          <li key={p.key} className={p.key === selectedKey ? "selected" : ""}>
            <button type="button" onClick={() => void selectPackage(p.key)}>
              <strong>{p.manifest.name}</strong> <code>{p.key}</code>{" "}
              <span className="status">{p.latestVersion ?? "未发布"}</span>
            </button>
          </li>
        ))}
      </ul>
      {draft === null ? null : (
        <div className="panel panel-themed">
          <h3>{draft.manifest.name} · 草稿</h3>
          <p>{draft.manifest.description}</p>
          <p><small>策略：{draft.manifest.strategy} · 执行顺序：{draft.manifest.execution_order.join(" → ")}</small></p>
          <div className="compact-form">
            <button type="button" onClick={() => void runChecks()}>运行检查</button>
            <input value={publishVersion} onChange={(e) => setPublishVersion(e.target.value)} placeholder="1.0.0" />
            <button type="button" onClick={() => void publish()} disabled={publishVersion === ""}>发布</button>
          </div>
          {versions.length === 0 ? null : (
            <div>
              <h4>版本记录</h4>
              <ul>
                {versions.map((v) => (
                  <li key={v.version}><strong>{v.version}</strong> <span>{v.changeNote ?? ""}</span></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
