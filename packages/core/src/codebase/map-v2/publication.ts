import { contentHash, stableHash, stableJson } from "./stable.js";
import { isRfc3339DateTime, projectMapManifest } from "./manifest.js";
import { estimateMapEvidenceTokenCost } from "./evidence.js";
import { scanSensitiveFiles } from "../../security/scanner.js";
import {
  CODEBASE_MAP_V2_DOCUMENTS,
  CODEBASE_MAP_PUBLICATION_TARGETS,
  type MapDocumentName,
  type MapManifestDraftV2,
  type MapManifestV2,
  type MapPublicationTargetPath,
  type MapPublicationFailureReason,
  type MapPublicationPlan,
  type MapPublicationPlanInput
} from "./types.js";

const canonicalDocumentSet = new Set<string>(CODEBASE_MAP_V2_DOCUMENTS);
const governanceHeading = /(?:^|\n)#{1,6}\s*(?:rules?|governance|polic(?:y|ies)|规则|治理|政策)\b/iu;
const englishGovernanceDirective = /\b(?:(?:all|every)\s+)?(?:agents?|contributors?|developers?|maintainers?)\b[^\n.!?]{0,80}\b(?:must|shall|may\s+not)\b/iu;
const chineseGovernanceDirective = /(?:所有|全部|任何)?\s*(?:agents?|代理|智能体|开发者|贡献者|维护者|使用者)[^\n。！？]{0,40}(?:必须|不得|禁止|应当|务必)/iu;
const directEnglishGovernanceDirective =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:you|changes?|this\s+project|the\s+project)\b[^\n.!?]{0,80}\b(?:must|shall|may\s+not)\b/iu;
const directChineseGovernanceDirective =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:(?:本项目|项目|变更)\s*)?(?:必须|不得|禁止|应当|务必)/u;
const subjectlessEnglishGovernanceDirective =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:must|shall|may\s+not)\b/iu;
const pathEvidence = /(?:^|[\s`'(])(?:\.?[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_-]+)?(?=$|[\s`'),:])/u;
const sha256 = /^sha256:[a-f0-9]{64}$/u;

function failure(
  input: MapPublicationPlanInput,
  reason: MapPublicationFailureReason
): MapPublicationPlan {
  return {
    ok: false,
    reason_codes: [reason],
    ...(input.previous_manifest_hash === undefined
      ? {}
      : { retained_manifest_hash: input.previous_manifest_hash }),
    operations: []
  };
}

function hasOnlyCanonicalKeys(record: Readonly<Record<string, string>>): boolean {
  return Object.keys(record).every((name) => canonicalDocumentSet.has(name));
}

function draftWithoutPublicationTime(draft: MapManifestDraftV2): MapManifestDraftV2 {
  const copy = { ...draft } as MapManifestDraftV2 & { published_at?: unknown };
  delete copy.published_at;
  return copy;
}

function containsGovernanceDirective(content: string): boolean {
  return governanceHeading.test(content) || englishGovernanceDirective.test(content) ||
    chineseGovernanceDirective.test(content) || directEnglishGovernanceDirective.test(content) ||
    directChineseGovernanceDirective.test(content) ||
    subjectlessEnglishGovernanceDirective.test(content);
}

function isValidManifestDraft(draft: MapManifestDraftV2, publishedAt: string): boolean {
  if ((draft as MapManifestDraftV2 & { published_at?: unknown }).published_at !== undefined) {
    return false;
  }
  const readBack = projectMapManifest({
    ...draft,
    published_at: publishedAt
  });
  return readBack.ok && readBack.source_schema_version === 2;
}

export function planMapPublication(input: MapPublicationPlanInput): MapPublicationPlan {
  if (!isRfc3339DateTime(input.published_at)) {
    return failure(input, "MAP_PUBLICATION_TIMESTAMP_INVALID");
  }
  const affected = new Set<string>(input.affected_documents);
  if (affected.size === 0 || affected.size !== input.affected_documents.length ||
      [...affected].some((name) => !canonicalDocumentSet.has(name)) ||
      !hasOnlyCanonicalKeys(input.previous_documents) ||
      !hasOnlyCanonicalKeys(input.proposed_documents) ||
      Object.keys(input.proposed_documents).some((name) => !affected.has(name)) ||
      (input.mode !== "full" && input.previous_manifest_hash === undefined) ||
      (input.previous_manifest_hash !== undefined && !sha256.test(input.previous_manifest_hash)) ||
      (input.mode === "full" && affected.size !== CODEBASE_MAP_V2_DOCUMENTS.length)) {
    return failure(input, "PUBLICATION_SCOPE_INVALID");
  }
  if (!isValidManifestDraft(input.manifest_draft, input.published_at)) {
    return failure(input, "MAP_MANIFEST_DRAFT_INVALID");
  }

  const documents = {} as Record<MapDocumentName, string>;
  for (const name of CODEBASE_MAP_V2_DOCUMENTS) {
    const content = affected.has(name)
      ? input.proposed_documents[name]
      : input.previous_documents[name];
    if (content === undefined) return failure(input, "MAP_DOCUMENT_MISSING");
    if (content.trim().length === 0) return failure(input, "MAP_DOCUMENT_EMPTY");
    documents[name] = content;
  }
  if (input.summary_content.trim().length === 0) return failure(input, "MAP_DOCUMENT_EMPTY");
  if (containsGovernanceDirective(documents["ARCHITECTURE.md"])) {
    return failure(input, "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN");
  }
  if (containsGovernanceDirective(documents["CONVENTIONS.md"])) {
    return failure(input, "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN");
  }
  if (!pathEvidence.test(documents["ARCHITECTURE.md"])) {
    return failure(input, "ARCHITECTURE_EVIDENCE_MISSING");
  }

  const changedDocuments = CODEBASE_MAP_V2_DOCUMENTS.filter((name) => affected.has(name));
  const preservedDocuments = CODEBASE_MAP_V2_DOCUMENTS.filter((name) => !affected.has(name));
  const oldMetadata = new Map(input.manifest_draft.documents.map((document) => [
    document.path.split("/").at(-1), document
  ]));
  const manifestDraft: MapManifestDraftV2 = {
    ...draftWithoutPublicationTime(input.manifest_draft),
    documents: CODEBASE_MAP_V2_DOCUMENTS.map((name) => {
      const old = oldMetadata.get(name);
      return {
        path: `.harness/codebase/map/${name}`,
        topics: old?.topics ?? [name.replace(/\.md$/u, "").toLowerCase()],
        evidence_sources: old?.evidence_sources ?? [],
        input_fingerprint: old?.input_fingerprint ?? input.manifest_draft.input_fingerprint,
        content_hash: contentHash(documents[name]),
        estimated_tokens: estimateMapEvidenceTokenCost(documents[name]).tokens,
        status: affected.has(name) ? "refreshed" : "unchanged"
      };
    }),
    summary_hash: contentHash(input.summary_content)
  };
  const manifest: MapManifestV2 = {
    ...manifestDraft,
    published_at: input.published_at
  };
  const readBack = projectMapManifest(manifest);
  if (!readBack.ok || readBack.source_schema_version !== 2) {
    return failure(input, "MAP_MANIFEST_DRAFT_INVALID");
  }
  const manifestPayload = stableJson(manifest);
  const sensitiveScan = scanSensitiveFiles({
    ...Object.fromEntries(CODEBASE_MAP_V2_DOCUMENTS.map((name) => [
      `.harness/codebase/map/${name}`,
      documents[name]
    ])),
    ".harness/codebase/map-summary.md": input.summary_content,
    ".harness/codebase/map-manifest.json": manifestPayload
  });
  if (sensitiveScan.blocked) {
    return failure(input, "SENSITIVE_OUTPUT_DETECTED");
  }
  const payloads = Object.freeze(Object.fromEntries([
    ...CODEBASE_MAP_V2_DOCUMENTS.map((name) =>
      [`.harness/codebase/map/${name}` as const, documents[name]] as const),
    [".harness/codebase/map-summary.md", input.summary_content] as const,
    [".harness/codebase/map-manifest.json", manifestPayload] as const
  ])) as Readonly<Record<MapPublicationTargetPath, string>>;
  const operations = [
    ...CODEBASE_MAP_PUBLICATION_TARGETS.map((path) => ({
      operation: "stage_write" as const,
      path,
      content_hash: contentHash(payloads[path])
    })),
    {
      operation: "atomic_replace_set" as const,
      staged_paths: [
        ...CODEBASE_MAP_V2_DOCUMENTS.map((name) => `map/${name}`),
        "map-summary.md",
        "map-manifest.json"
      ],
      target_paths: [
        ...CODEBASE_MAP_V2_DOCUMENTS.map((name) => `.harness/codebase/map/${name}`),
        ".harness/codebase/map-summary.md",
        ".harness/codebase/map-manifest.json"
      ],
      rollback_on_failure: true as const,
      ...(input.previous_manifest_hash === undefined
        ? {}
        : { expected_previous_manifest_hash: input.previous_manifest_hash })
    }
  ];
  return {
    ok: true,
    plan_hash: stableHash({
      payloads,
      identity: {
        project_identity: manifest.project_identity,
        repository_identity: manifest.repository_identity,
        input_fingerprint: manifest.input_fingerprint
      }
    }),
    payloads,
    documents,
    changed_documents: changedDocuments,
    preserved_documents: preservedDocuments,
    manifest,
    manifest_payload: manifestPayload,
    manifest_draft: manifest,
    operations
  };
}
