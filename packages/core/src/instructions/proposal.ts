import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { projectConfigSchema } from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { HunterHarnessApiClient } from "../api/client.js";
import {
  assessCodebaseMapOnDisk,
  CODEBASE_MAP_DOCUMENTS
} from "../codebase/map.js";
import { sha256Bytes } from "../fs/hash.js";
import { uuidV7 } from "../project/uuid-v7.js";
import { readLocalCredentials, resolvePushAuth } from "../push/credentials.js";
import { atomicWriteJson } from "../state/atomic.js";
import { runTransaction } from "../transaction/transaction.js";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const portableProposalIdSchema = z.string()
  .regex(/^ipr_[A-Za-z0-9][A-Za-z0-9_-]{0,155}$/u);
const proposedFileSchema = z.object({
  path: z.enum([
    "AGENTS.md",
    "CLAUDE.md",
    "CODEBUDDY.md",
    ".harness/rules/project-guidance.md",
    ".cursor/rules/project-guidance.mdc"
  ]),
  operation: z.enum(["add", "modify"]),
  base_content_sha256: sha256Schema.nullable(),
  content_sha256: sha256Schema,
  content: z.string().max(1024 * 1024)
}).strict();
const instructionFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warning"]),
  path: z.string(),
  message: z.string()
}).strict();
const ruleCandidateSchema = z.object({
  candidate_id: z.string().regex(/^rc_[a-f0-9]{16}$/u),
  content: z.string(),
  evidence: z.array(z.object({
    change_key: z.string(),
    summary: z.string()
  }).strict()),
  evidence_count: z.number().int().positive(),
  auto_apply: z.literal(false),
  recommendation: z.enum(["review", "promote"])
}).strict();

export const localInstructionProposalSchema = z.object({
  schema_version: z.literal(1),
  proposal_id: portableProposalIdSchema,
  project_id: z.string().regex(/^prj_/u),
  language: z.literal("zh-CN"),
  mode: z.literal("audit-propose"),
  applied: z.literal(false),
  generated_at: z.iso.datetime(),
  findings: z.array(instructionFindingSchema),
  files: z.array(proposedFileSchema),
  rule_candidates: z.array(ruleCandidateSchema),
  basis: z.array(z.url()),
  request_id: z.uuid()
}).strict();

function proposalStatePath(root: string, filename: string): string {
  const stateRoot = resolve(
    root,
    ".harness",
    "state",
    "local",
    "instruction-proposals"
  );
  const candidate = resolve(stateRoot, filename);
  const relation = relative(stateRoot, candidate);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new InstructionProposalError(
      "文档提案标识不能用于本地路径",
      "INSTRUCTION_PROPOSAL_INVALID",
      6
    );
  }
  return candidate;
}

export class InstructionProposalError extends Error {
  readonly code: string;
  readonly exitCode: 3 | 4 | 6 | 8;

  constructor(message: string, code: string, exitCode: 3 | 4 | 6 | 8) {
    super(message);
    this.name = "InstructionProposalError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const EVIDENCE_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CODEBUDDY.md",
  ".harness/rules/project-guidance.md",
  ".cursor/rules/project-guidance.mdc",
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pyproject.toml"
] as const;

async function readOptionalText(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    if (metadata.size > 512 * 1024) return null;
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function projectConfig(root: string) {
  try {
    return projectConfigSchema.parse(parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ));
  } catch {
    throw new InstructionProposalError(
      "项目配置不存在或无效",
      "PROJECT_CONFIG_INVALID",
      3
    );
  }
}

async function codebaseMapEvidence(root: string) {
  const assessment = await assessCodebaseMapOnDisk(root);
  const contents: string[] = [];
  for (const name of CODEBASE_MAP_DOCUMENTS) {
    const content = await readOptionalText(join(root, ".harness", "codebase", "map", name));
    if (content !== null) contents.push(`# ${basename(name, ".md")}\n${content}`);
  }
  return {
    status: assessment.status,
    content: contents.join("\n\n").slice(0, 512 * 1024)
  };
}

function profileFromEvidence(paths: ReadonlySet<string>): string {
  if (paths.has("package.json")) return "typescript-javascript";
  if (paths.has("pom.xml") || paths.has("build.gradle") || paths.has("build.gradle.kts")) {
    return "java-jvm";
  }
  if (paths.has("pyproject.toml")) return "python";
  return "general";
}

export async function auditProjectInstructions(options: {
  projectRoot: string;
  serverUrl?: string;
  tokenEnv?: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
}) {
  const root = resolve(options.projectRoot);
  const project = await projectConfig(root);
  const credentials = await readLocalCredentials(root);
  const auth = resolvePushAuth({
    ...(options.serverUrl === undefined ? {} : { serverUrlFlag: options.serverUrl }),
    ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
    env: options.env,
    local: credentials,
    projectUrl: project.server.url,
    projectTokenEnv: project.server.token_env
  });
  if ("code" in auth) {
    throw new InstructionProposalError(
      auth.code === "SERVER_URL_REQUIRED" ? "未配置文档审计服务地址" : "未配置文档审计凭据",
      auth.code,
      auth.code === "SERVER_URL_REQUIRED" ? 3 : 8
    );
  }
  const remoteProjectId = credentials?.project_id ?? project.project.project_id;
  if (remoteProjectId === null || remoteProjectId === undefined) {
    throw new InstructionProposalError(
      "项目尚未绑定远端平台；请先运行 hunter-harness connect",
      "PROJECT_NOT_BOUND",
      3
    );
  }
  const documents = [];
  for (const path of EVIDENCE_PATHS) {
    const content = await readOptionalText(join(root, ...path.split("/")));
    if (content !== null) {
      documents.push({ path, content, content_sha256: sha256Bytes(content) });
    }
  }
  const client = new HunterHarnessApiClient({
    serverUrl: auth.serverUrl,
    token: auth.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const result = localInstructionProposalSchema.parse(await client.createInstructionProposal({
    projectId: remoteProjectId,
    body: {
      schema_version: 1,
      language: "zh-CN",
      project_profile: profileFromEvidence(new Set(documents.map((document) => document.path))),
      adapters: project.adapters.enabled.flatMap((adapter) =>
        adapter === "generic" || adapter === "mcp" ? [] : [adapter]
      ),
      documents,
      codebase_map: await codebaseMapEvidence(root),
      // Recent change summaries are loaded from server-owned archive packages,
      // so instruction quality does not depend on local archives surviving.
      recent_changes: []
    },
    requestId: uuidV7(),
    idempotencyKey: uuidV7()
  }));
  const proposalPath = proposalStatePath(root, result.proposal_id + ".json");
  await atomicWriteJson(proposalPath, result);
  return { proposal: result, proposalPath };
}

export async function applyInstructionProposal(options: {
  projectRoot: string;
  proposalPath: string;
}) {
  const root = resolve(options.projectRoot);
  let proposal: z.infer<typeof localInstructionProposalSchema>;
  try {
    proposal = localInstructionProposalSchema.parse(JSON.parse(
      await readFile(resolve(root, options.proposalPath), "utf8")
    ));
  } catch {
    throw new InstructionProposalError(
      "文档提案不存在或格式无效",
      "INSTRUCTION_PROPOSAL_INVALID",
      6
    );
  }
  const project = await projectConfig(root);
  const credentials = await readLocalCredentials(root);
  const projectId = credentials?.project_id ?? project.project.project_id;
  if (projectId !== proposal.project_id) {
    throw new InstructionProposalError(
      "提案不属于当前项目",
      "INSTRUCTION_PROPOSAL_PROJECT_MISMATCH",
      4
    );
  }

  const operations: Array<{
    operation: "add" | "modify";
    path: string;
    content: string;
  }> = [];
  for (const file of proposal.files) {
    if (sha256Bytes(file.content) !== file.content_sha256) {
      throw new InstructionProposalError(
        `提案文件哈希无效：${file.path}`,
        "INSTRUCTION_PROPOSAL_HASH_MISMATCH",
        6
      );
    }
    const current = await readOptionalText(join(root, ...file.path.split("/")));
    const currentHash = current === null ? null : sha256Bytes(current);
    if (currentHash !== file.base_content_sha256) {
      throw new InstructionProposalError(
        `文件已在提案后发生变化：${file.path}`,
        "INSTRUCTION_PROPOSAL_STALE",
        4
      );
    }
    operations.push({
      operation: current === null ? "add" : "modify",
      path: file.path,
      content: file.content
    });
  }
  const transaction = await runTransaction(root, operations);
  const receiptPath = proposalStatePath(
    root,
    proposal.proposal_id + ".applied.json"
  );
  await atomicWriteJson(receiptPath, {
    schema_version: 1,
    proposal_id: proposal.proposal_id,
    project_id: proposal.project_id,
    applied_at: new Date().toISOString(),
    transaction_id: transaction.transactionId,
    files: proposal.files.map((file) => ({ path: file.path, content_sha256: file.content_sha256 })),
    rule_candidates_applied: false
  });
  return { proposal, receiptPath, transaction };
}
