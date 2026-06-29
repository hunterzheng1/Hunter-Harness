export type ProfileId = "general" | "java" | "node" | "python" | "docs" | "personal-automation";
export type AdapterId = "claude-code" | "codex" | "cursor" | "generic" | "mcp";

export interface BootstrapSkill {
  name: string;
  kind: "workflow" | "tooling" | "migration" | "governance";
  description: string;
  version: string;
  profiles: ProfileId[];
  adapters: AdapterId[];
  triggers: string[];
  inputs: string[];
  outputs: string[];
  forbiddenActions: string[];
  requiredContext: string[];
  instructions: string[];
}

export const profiles: ReadonlyArray<{ id: ProfileId; label: string; description: string }> = [
  { id: "general", label: "General", description: "The cross-agent governance workflow used by all bootstrap projects." },
  { id: "java", label: "Java", description: "General workflow plus Java-oriented documentation and package preparation." },
  { id: "node", label: "Node", description: "Bootstrap optimizer coverage for Node-specific skill migration." },
  { id: "python", label: "Python", description: "Bootstrap optimizer coverage for Python-specific skill migration." },
  { id: "docs", label: "Docs", description: "Bootstrap optimizer coverage for documentation-focused skill migration." },
  { id: "personal-automation", label: "Personal automation", description: "Bootstrap optimizer coverage for personal automation skills." }
];

const allAdapters: AdapterId[] = ["claude-code", "codex", "cursor", "generic", "mcp"];
const coreProfiles: ProfileId[] = ["general", "java"];

function skill(
  name: string,
  kind: BootstrapSkill["kind"],
  description: string,
  triggers: string[],
  inputs: string[],
  outputs: string[],
  forbiddenActions: string[],
  requiredContext: string[],
  instructions: string[],
  skillProfiles: ProfileId[] = coreProfiles
): BootstrapSkill {
  return {
    name,
    kind,
    description,
    version: "1.0.0",
    profiles: skillProfiles,
    adapters: allAdapters,
    triggers,
    inputs,
    outputs,
    forbiddenActions,
    requiredContext,
    instructions
  };
}

export const bootstrapSkills: readonly BootstrapSkill[] = [
  skill("harness-sync", "workflow", "Check Harness context, Knowledge indexes, managed blocks, rules, and codebase-map freshness.", ["sync harness context", "check project context"], ["project_root", "context_index"], ["sync_report", "refresh_recommendations"], ["automatic_codebase_map_execution", "manage_codegraph", "install_external_tools"], ["AGENTS.md", ".harness/context-index.json"], ["Validate managed blocks and local Harness structure.", "Rebuild deterministic indexes when sources changed.", "Recommend a map refresh but wait for explicit confirmation."]),
  skill("harness-plan", "workflow", "Produce evidence-based designs, implementation plans, impact analysis, and test scenarios.", ["plan a change", "design an implementation"], ["requirements", "context_index"], ["design", "implementation_plan", "test_scenarios"], ["invent_evidence", "expose_sensitive_data", "automatic_source_control_write"], ["AGENTS.md", ".harness/context-index.json", ".harness/knowledge/index.json"], ["Inspect relevant Knowledge and codebase evidence.", "Separate assumptions from verified facts.", "Define exact files, tests, risks, and rollback points."]),
  skill("harness-run", "workflow", "Execute an approved implementation plan with test-first evidence and an execution log.", ["implement the plan", "run approved tasks"], ["implementation_plan", "test_scenarios"], ["implementation_changes", "execution_log"], ["skip_red_green_verification", "claim_unverified_success", "automatic_source_control_write"], ["AGENTS.md", ".harness/context-index.json"], ["Execute one bounded task at a time.", "Record real command output.", "Stop on unsafe or unexplained failures."]),
  skill("harness-test", "workflow", "Validate changes with real tests, explicit degradation reporting, and reproducible evidence.", ["test the change", "validate behavior"], ["test_scenarios", "change_ref"], ["test_report", "evidence_summary"], ["claim_unrun_tests_pass", "hide_test_failures", "confuse_static_checks_with_tests"], ["AGENTS.md", ".harness/context-index.json", ".harness/knowledge/pitfalls"], ["Derive test cases from requirements.", "Run narrow then complete relevant suites.", "Report skipped infrastructure explicitly."]),
  skill("harness-review", "governance", "Review changes across correctness, security, compatibility, tests, maintainability, and evidence.", ["review a change", "inspect implementation quality"], ["change_ref", "context_index"], ["review_report", "evidence_summary"], ["invent_findings", "claim_unverified_success", "mutate_reviewed_code_without_request"], ["AGENTS.md", ".harness/context-index.json", ".harness/knowledge/index.json"], ["Inspect actual diffs and project evidence.", "Rank actionable findings by impact.", "Distinguish defects from risks and questions."]),
  skill("harness-submit", "workflow", "Prepare a submission summary, suggested message, and verification checklist without changing source control.", ["prepare submission", "summarize completed change"], ["change_ref", "verification_evidence"], ["submission_summary", "suggested_message", "submission_checklist"], ["source_control_write_without_explicit_confirmation", "publish_without_review"], ["AGENTS.md", ".harness/context-index.json"], ["Summarize verified changes and remaining risks.", "Produce a suggested message and checklist only.", "Require explicit confirmation before source-control mutation."]),
  skill("harness-archive", "workflow", "Archive completed change evidence and extract unpromoted candidate Knowledge.", ["archive completed change", "extract reusable knowledge"], ["change_documents", "verification_evidence"], ["archive_summary", "candidate_knowledge"], ["auto_promote_candidate_knowledge", "discard_evidence", "expose_sensitive_data"], ["AGENTS.md", ".harness/context-index.json"], ["Preserve final execution evidence.", "Extract reusable facts as candidates.", "Never promote candidates automatically."]),
  skill("harness-knowledge-ingest", "governance", "Validate, deduplicate, index, and propose project Knowledge without bypassing review.", ["ingest knowledge", "rebuild knowledge index"], ["knowledge_entries", "candidate_entries"], ["knowledge_index", "validation_report"], ["auto_promote_candidate_knowledge", "include_project_local_by_default", "erase_conflicts"], ["AGENTS.md", ".harness/knowledge/index.json"], ["Validate frontmatter and lifecycle relationships.", "Detect duplicate and conflicting active facts.", "Exclude project-local entries unless selected."]),
  skill("harness-skill-optimizer", "migration", "Create, optimize, and migrate platform-neutral Skill IR with adapter-safe outputs.", ["create a skill", "optimize a skill", "migrate an agent skill"], ["skill_source", "target_profiles", "target_adapters"], ["skill_ir", "validation_report", "adapter_preview"], ["publish_canonical_skill", "automatic_proposal_push", "broaden_capabilities", "automatic_source_control_write"], ["AGENTS.md", ".harness/context-index.json"], ["Convert source workflows into canonical Skill IR.", "Validate contracts and constraints.", "Generate previews but never publish automatically."], ["general", "java", "node", "python", "docs", "personal-automation"]),
  skill("harness-codebase-map", "workflow", "Generate seven evidence-based codebase-map documents under the Harness workspace.", ["map the codebase", "refresh codebase map"], ["project_root", "optional_paths"], ["stack_map", "integration_map", "architecture_map", "structure_map", "convention_map", "testing_map", "concern_map"], ["copy_source_code_wholesale", "manage_codegraph", "automatic_execution_from_sync"], ["AGENTS.md", ".harness/context-index.json"], ["Analyze requested scope using mapper focuses.", "Write all seven maps.", "Record evidence without embedding source files."]),
  skill("harness-apidoc", "workflow", "Analyze API changes and produce evidence-based documentation impact updates.", ["update API documentation", "inspect API compatibility"], ["change_ref", "api_contract"], ["api_impact_report", "documentation_updates"], ["invent_api_behavior", "hide_breaking_changes", "publish_without_review"], ["AGENTS.md", ".harness/context-index.json", ".harness/knowledge/api"], ["Compare implementation and declared contracts.", "Classify compatibility and documentation impact.", "Update evidence-supported documentation only."]),
  skill("harness-package", "workflow", "Validate and prepare a reproducible project package without publishing it.", ["prepare package", "validate package output"], ["project_root", "build_configuration"], ["package_report", "package_artifacts"], ["publish_artifact", "expose_secrets", "claim_unverified_build"], ["AGENTS.md", ".harness/context-index.json"], ["Validate build and required tests.", "Record hashes and build evidence.", "Do not publish or upload artifacts."])
];

export const workflowOrder = [
  "harness-sync", "harness-plan", "harness-run", "harness-test", "harness-review", "harness-archive"
] as const;

export function findSkill(skillId: string): BootstrapSkill | undefined {
  return bootstrapSkills.find((item) => item.name === skillId);
}

export function compileClaudePreview(skill: BootstrapSkill): string {
  return [
    "---",
    "name: " + skill.name,
    "description: " + skill.description,
    "---",
    "",
    "# " + skill.name,
    "",
    "## Triggers",
    ...skill.triggers.map((item) => "- " + item),
    "",
    "## Required context",
    ...skill.requiredContext.map((item) => "- " + item),
    "",
    "## Instructions",
    ...skill.instructions.map((item) => "- " + item),
    "",
    "## Forbidden actions",
    ...skill.forbiddenActions.map((item) => "- " + item)
  ].join("\n");
}
