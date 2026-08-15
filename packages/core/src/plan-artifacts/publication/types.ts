import type {
  HumanArtifactBuildInput,
  HumanArtifactSet,
  ImplementationDetailArtifact,
  MachineArtifactDerivationInput,
  MachineArtifactSet
} from "../types.js";

export type PlanPublicationFormat = "markdown" | "json";
export type PlanPublicationClassification =
  | "human_truth"
  | "machine_derived"
  | "compatibility_derived";

export interface TrustedPlanArtifactSet {
  readonly human_input: HumanArtifactBuildInput;
  readonly human: HumanArtifactSet;
  readonly machine_input: Omit<MachineArtifactDerivationInput, "human" | "human_input">;
  readonly machine: MachineArtifactSet;
  readonly detail: ImplementationDetailArtifact;
}

export interface PlanPublicationPayload {
  readonly path: string;
  readonly artifact_type: string;
  readonly format: PlanPublicationFormat;
  readonly classification: PlanPublicationClassification;
  readonly serialized_content: string;
  readonly bytes: readonly number[];
  readonly byte_length: number;
  readonly serialized_sha256: string;
  readonly semantic_content_hash: string;
}

export type PlanPublicationPayloadDescriptor = Omit<PlanPublicationPayload,
  "serialized_content" | "bytes">;

export interface PlanArtifactPublicationManifest {
  readonly schema_version: 1;
  readonly change_key: string;
  readonly approval_receipt_ref: string;
  readonly artifact_derivation_receipt_refs: readonly [string, string, string];
  readonly ownership_paths: readonly string[];
  readonly entries: readonly PlanPublicationPayloadDescriptor[];
}

export interface PlanArtifactPublicationPlan {
  readonly schema_version: 1;
  readonly change_key: string;
  readonly publication_intent_id: string;
  readonly manifest_hash: string;
  readonly manifest: PlanArtifactPublicationManifest;
  readonly approval_receipt_ref: string;
  readonly artifact_derivation_receipt_refs: readonly [string, string, string];
  readonly ownership_paths: readonly string[];
  readonly payloads: readonly PlanPublicationPayload[];
}

export interface PlanPublicationPathAuthorityPort {
  verify(input: {
    readonly change_key: string;
    readonly paths: readonly string[];
  }): boolean;
}

export type PlanArtifactPublicationResult =
  | { readonly ok: true; readonly mode: "current"; readonly plan: PlanArtifactPublicationPlan }
  | { readonly ok: false; readonly reason_code:
      | "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID"
      | "PLAN_ARTIFACT_PUBLICATION_PATH_UNAUTHORIZED"
      | "PLAN_ARTIFACT_PUBLICATION_LEGACY_READ_ONLY" };
