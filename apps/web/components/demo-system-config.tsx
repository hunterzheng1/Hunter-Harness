"use client";

import type { DemoAgent, DemoAgentConfig } from "../lib/demo-skills/types";
import type { useI18n } from "../lib/i18n";
import { Status, agentLabel } from "./skill-shared";

function DemoSystemConfig({
  agents,
  currentAgent,
  defaultAgent,
  onSetDefault,
  t
}: {
  agents: readonly DemoAgentConfig[];
  currentAgent: DemoAgentConfig | undefined;
  defaultAgent: DemoAgent;
  onSetDefault: (agent: DemoAgent) => void;
  t: ReturnType<typeof useI18n>["t"]["skillDetail"];
}) {
  const configuredAgents = agents.filter((item) => item.configured);
  const defaultConfig = agents.find((item) => item.agent === defaultAgent);
  return <article className="system-config-card system-config-card-wide">
    <span className="config-card-label">{t.defaultAgent}</span>
    <div className="default-agent-heading">
      <div>
        <h3>{defaultConfig?.label ?? agentLabel(defaultAgent)}</h3>
        <p>{t.defaultAgentDescription}</p>
      </div>
      {defaultConfig === undefined ? null : <Status value="default" />}
    </div>
    <dl>
      <dt>{t.currentAgent}</dt>
      <dd>{currentAgent?.label ?? agentLabel(defaultAgent)} · {currentAgent?.configured ? t.currentAgentConfigured : t.currentAgentFallback}</dd>
    </dl>
    <div className="default-agent-actions">
      {configuredAgents.map((item) => item.agent === defaultAgent
        ? <span className="config-chip config-chip-enabled" key={item.agent}>{item.label}<small>{t.defaultAgent}</small></span>
        : <button type="button" className="secondary" key={item.agent} onClick={() => onSetDefault(item.agent)}>{t.setDefault} · {item.label}</button>)}
    </div>
  </article>;
}

export { DemoSystemConfig };
