import { describe, expect, it } from "vitest";

import type { SkillFrontmatter, SourceFile } from "@hunter-harness/contracts";
import { buildAiCheckPrompt, DeepSeekLlmClient, parseAiCheckResult } from "../src/index.js";

const baseMeta: SkillFrontmatter = {
  name: "harness-x",
  description: "demo skill",
  triggers: ["run"],
  inputs: ["ctx"],
  outputs: ["out"],
  forbidden_actions: ["automatic_git_write"],
  required_context: ["AGENTS.md"],
  version: "1.0.0"
};

const baseFiles: SourceFile[] = [
  { path: "SKILL.md", content: "# harness-x skill" },
  { path: "references/ref.md", content: "reference doc" }
];

describe("buildAiCheckPrompt", () => {
  it("system contains 8 AI_ check ids and injection guard", () => {
    const p = buildAiCheckPrompt({ meta: baseMeta, sourceFiles: baseFiles });
    const ids = [
      "AI_TRIGGER_QUALITY",
      "AI_BODY_QUALITY",
      "AI_USAGE_EXAMPLES",
      "AI_CONFIG_EXTRACTION",
      "AI_CROSS_AGENT",
      "AI_SAFETY_BOUNDARY",
      "AI_FIX_SUGGESTION",
      "AI_CHANGE_NOTE"
    ];
    for (const id of ids) {
      expect(p.system).toContain(id);
    }
    expect(p.system.toLowerCase()).toContain("data");
    expect(p.system.toLowerCase()).toContain("instruction");
  });

  it("user wraps source files in skill_data tag and includes meta metadata", () => {
    const p = buildAiCheckPrompt({ meta: baseMeta, sourceFiles: baseFiles });
    expect(p.user).toContain("<skill_data>");
    expect(p.user).toContain("</skill_data>");
    expect(p.user).toContain(baseMeta.name);
    expect(p.user).toContain(baseMeta.description);
  });
});

describe("parseAiCheckResult", () => {
  it("parses valid JSON into SkillCheckResult", () => {
    const raw = JSON.stringify({
      items: [{ id: "AI_X", label: "x", status: "green", message: "ok", filePath: null, fixable: false }],
      summary: { green: 1, yellow: 0, red: 0 },
      checkedAt: "2026-06-28T00:00:00Z"
    });
    const r = parseAiCheckResult(raw);
    expect(r.items).toHaveLength(1);
    expect(r.summary.green).toBe(1);
  });

  it("degrades to AI_PARSE_FAILED yellow on invalid JSON", () => {
    const r = parseAiCheckResult("not json");
    expect(r.items[0].id).toBe("AI_PARSE_FAILED");
    expect(r.items[0].status).toBe("yellow");
    expect(r.summary.yellow).toBe(1);
  });

  it("degrades to AI_PARSE_FAILED on schema mismatch", () => {
    const r = parseAiCheckResult(JSON.stringify({ foo: "bar" }));
    expect(r.items[0].id).toBe("AI_PARSE_FAILED");
  });

  it("strips markdown fence (```json ... ```)", () => {
    const raw = "```json\n" + JSON.stringify({
      items: [{ id: "AI_X", label: "x", status: "green", message: "ok", filePath: null, fixable: false }],
      summary: { green: 1, yellow: 0, red: 0 },
      checkedAt: "2026-06-28T00:00:00Z"
    }) + "\n```";
    const r = parseAiCheckResult(raw);
    expect(r.items[0]?.id).toBe("AI_X");
  });

  it("extracts JSON from leading/trailing prose text", () => {
    const raw = "Here is the result:\n" + JSON.stringify({
      items: [{ id: "AI_Y", label: "y", status: "yellow", message: "warn", filePath: null, fixable: false }],
      summary: { green: 0, yellow: 1, red: 0 },
      checkedAt: "2026-06-28T00:00:00Z"
    }) + "\nDone.";
    const r = parseAiCheckResult(raw);
    expect(r.items[0]?.id).toBe("AI_Y");
  });

  it("fills missing checkedAt with current time", () => {
    const raw = JSON.stringify({
      items: [{ id: "AI_Z", label: "z", status: "green", message: "ok", filePath: null, fixable: false }],
      summary: { green: 1, yellow: 0, red: 0 }
    });
    const r = parseAiCheckResult(raw);
    expect(r.items[0]?.id).toBe("AI_Z");
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("tolerates extra fields (LLM may add model/tokens)", () => {
    const raw = JSON.stringify({
      items: [{ id: "AI_X", label: "x", status: "green", message: "ok", filePath: null, fixable: false, extra: 1 }],
      summary: { green: 1, yellow: 0, red: 0 },
      checkedAt: "2026-06-28T00:00:00Z",
      model: "deepseek-v4-pro",
      tokens: 100
    });
    const r = parseAiCheckResult(raw);
    expect(r.items[0]?.id).toBe("AI_X");
    expect(r.summary.green).toBe(1);
  });
});

describe("DeepSeekLlmClient", () => {
  it("posts to chat/completions and returns content+usage", async () => {
    let calledUrl = "";
    let calledBody = "";
    const fetchImpl = async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledBody = String(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "AI result" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      };
    };
    const client = new DeepSeekLlmClient({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "sk-test",
      fetchImpl
    });
    const r = await client.analyze({ system: "s", user: "u" });
    expect(r.content).toBe("AI result");
    expect(r.usage?.tokens).toBe(15);
    expect(calledUrl).toContain("https://api.deepseek.com");
    expect(calledUrl).toContain("chat/completions");
    const body = JSON.parse(calledBody);
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.messages).toHaveLength(2);
  });
});
