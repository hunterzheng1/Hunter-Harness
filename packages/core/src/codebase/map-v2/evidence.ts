import type {
  MapEvidenceBundle,
  MapEvidenceCandidate,
  MapEvidenceSelectionInput,
  MapEvidenceTopic
} from "./types.js";
import { classifyContentPath } from "@hunter-harness/contracts";
import { normalizeManagedPath } from "../../fs/path-safety.js";
import { scanSensitiveFiles } from "../../security/scanner.js";
import { compareCodepoint } from "./stable.js";

const packageAuthBasenames = new Set([
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials",
  "pip.conf", "settings.xml", "gradle.properties", "nuget.config"
]);
const credentialConfigBasename =
  /^(?:credentials?(?:\.[^./]+)?|client[-_]secret(?:\.[^./]+)*)$/u;

export type MapEvidencePathDecision =
  | { allowed: true; path: string }
  | {
    allowed: false;
    reason_code:
      | "MAP_EVIDENCE_PATH_INVALID"
      | "MAP_EVIDENCE_PATH_VCS_EXCLUDED"
      | "MAP_EVIDENCE_PATH_ENV_EXCLUDED"
      | "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"
      | "MAP_EVIDENCE_PATH_PACKAGE_AUTH_EXCLUDED"
      | "MAP_EVIDENCE_PATH_PRIVATE_KEY_EXCLUDED";
  };

/** Pure pre-read policy shared by Collect Adapters and evidence selection. */
export function assessMapEvidencePath(input: unknown): MapEvidencePathDecision {
  if (typeof input !== "string") {
    return { allowed: false, reason_code: "MAP_EVIDENCE_PATH_INVALID" };
  }
  let path: string;
  try {
    path = normalizeManagedPath(input);
  } catch {
    return { allowed: false, reason_code: "MAP_EVIDENCE_PATH_INVALID" };
  }
  const canonical = classifyContentPath({ schema_version: 1, path });
  if (!("content_kind" in canonical)) {
    if (canonical.reason_code === "CONTENT_PATH_VCS_EXCLUDED") {
      return { allowed: false, reason_code: "MAP_EVIDENCE_PATH_VCS_EXCLUDED" };
    }
    if (canonical.reason_code === "CONTENT_PATH_ENV_EXCLUDED") {
      return { allowed: false, reason_code: "MAP_EVIDENCE_PATH_ENV_EXCLUDED" };
    }
    if (canonical.reason_code === "CONTENT_PATH_CREDENTIALS_EXCLUDED") {
      return { allowed: false, reason_code: "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED" };
    }
  }
  const segments = path.toLowerCase().split("/");
  if (credentialConfigBasename.test(segments.at(-1) ?? "")) {
    return { allowed: false, reason_code: "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED" };
  }
  if (segments.some((segment) => packageAuthBasenames.has(segment))) {
    return { allowed: false, reason_code: "MAP_EVIDENCE_PATH_PACKAGE_AUTH_EXCLUDED" };
  }
  const basename = segments.at(-1) ?? "";
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*(?:private[-_]?key|\.key|\.p12|\.pfx)|private[^/]*\.pem)$/u
      .test(basename)) {
    return { allowed: false, reason_code: "MAP_EVIDENCE_PATH_PRIVATE_KEY_EXCLUDED" };
  }
  return { allowed: true, path };
}

function addReason<T>(reasons: T[], reason: T): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

const confidenceRank = { verified: 0, inferred: 1, unverified: 2 } as const;

/**
 * Conservative tokenizer-independent upper bound: a byte-level tokenizer can
 * always represent UTF-8 input in no more tokens than its byte length.
 */
export function estimateMapEvidenceTokenCost(content: string): {
  tokens: number;
  strategy: "utf8_byte_upper_bound";
} {
  return {
    tokens: Buffer.byteLength(content, "utf8"),
    strategy: "utf8_byte_upper_bound"
  };
}

export function selectMapEvidence(input: MapEvidenceSelectionInput): MapEvidenceBundle {
  const requestedTopics = [...new Set(input.topics)];
  const topicRank = new Map<MapEvidenceTopic, number>(
    requestedTopics.map((topic, index) => [topic, index])
  );
  const reasons: MapEvidenceBundle["truncation_reasons"][number][] = [];
  const eligible: MapEvidenceCandidate[] = [];
  for (const candidate of input.candidates) {
    if (!topicRank.has(candidate.topic)) continue;
    const pathDecision = assessMapEvidencePath(candidate.source_path);
    if (!pathDecision.allowed) {
      addReason(reasons, "SENSITIVE_PATH_EXCLUDED");
      continue;
    }
    if (scanSensitiveFiles({ [pathDecision.path]: candidate.content }).blocked) {
      addReason(reasons, "SENSITIVE_CONTENT_EXCLUDED");
      continue;
    }
    eligible.push({ ...candidate, source_path: pathDecision.path });
  }
  eligible.sort((left, right) =>
    (topicRank.get(left.topic) ?? Number.MAX_SAFE_INTEGER) -
      (topicRank.get(right.topic) ?? Number.MAX_SAFE_INTEGER) ||
    confidenceRank[left.confidence] - confidenceRank[right.confidence] ||
    compareCodepoint(left.source_path, right.source_path) ||
    compareCodepoint(left.evidence_source, right.evidence_source) ||
    compareCodepoint(left.content, right.content));

  const maxCharacters = Math.max(0, Math.floor(input.budget.max_characters));
  const maxTokens = Math.max(0, Math.floor(input.budget.max_tokens));
  const snippets: MapEvidenceCandidate[] = [];
  let characters = 0;
  let tokens = 0;
  for (const candidate of eligible) {
    const accepted: string[] = [];
    let acceptedTokens = 0;
    let blockedBy: "characters" | "tokens" | undefined;
    for (const character of candidate.content) {
      if (characters + accepted.length + 1 > maxCharacters) {
        blockedBy = "characters";
        break;
      }
      const tokenCost = estimateMapEvidenceTokenCost(character).tokens;
      if (tokens + acceptedTokens + tokenCost > maxTokens) {
        blockedBy = "tokens";
        break;
      }
      accepted.push(character);
      acceptedTokens += tokenCost;
    }
    const content = accepted.join("");
    if (blockedBy !== undefined) {
      addReason(reasons, blockedBy === "characters"
        ? "CHARACTER_BUDGET_EXHAUSTED"
        : "TOKEN_BUDGET_EXHAUSTED");
    }
    if (content.length === 0) continue;
    snippets.push({ ...candidate, content });
    characters += accepted.length;
    tokens += acceptedTokens;
  }
  for (const topic of requestedTopics) {
    if (!eligible.some((candidate) => candidate.topic === topic)) {
      addReason(reasons, "TOPIC_NOT_AVAILABLE");
    }
  }
  return {
    schema_version: 2,
    manifest_hash: input.manifest_hash,
    ...(input.source_commit === undefined ? {} : { source_commit: input.source_commit }),
    requested_topics: requestedTopics,
    snippets,
    used_budget: { characters, tokens },
    truncation_reasons: reasons
  };
}
