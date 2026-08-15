import type {
  ProviderApplicability,
  SyncActionPlan,
  SyncActionProvider,
  SyncActionReceipt,
  SyncApplyConfirmation,
  SyncContext,
  SyncFinding,
  SyncRollbackReceipt,
  SyncVerification
} from "./types.js";

export interface InMemorySyncActionProviderInput {
  readonly provider_id: string;
  readonly applicability: ProviderApplicability;
  readonly findings?: readonly SyncFinding[] | undefined;
  readonly actions?: readonly SyncActionPlan[] | undefined;
  readonly receipts?: Readonly<Record<string, SyncActionReceipt>> | undefined;
  readonly verifications?: Readonly<Record<string, SyncVerification>> | undefined;
  readonly inspect_error?: Error | undefined;
  readonly plan_error?: Error | undefined;
  readonly apply_error?: Error | undefined;
  readonly verify_error?: Error | undefined;
  readonly apply_errors?: Readonly<Record<string, Error>> | undefined;
  readonly verify_errors?: Readonly<Record<string, Error>> | undefined;
  readonly rollback_receipts?: Readonly<Record<string, SyncRollbackReceipt>> | undefined;
  readonly rollback_errors?: Readonly<Record<string, Error>> | undefined;
}

export class InMemorySyncActionProvider implements SyncActionProvider {
  readonly provider_id: string;
  readonly calls = { applicable: 0, inspect: 0, plan: 0, apply: 0, verify: 0, rollback: 0 };
  private readonly input: InMemorySyncActionProviderInput;

  constructor(input: InMemorySyncActionProviderInput) {
    this.provider_id = input.provider_id;
    this.input = input;
  }

  async applicable(): Promise<ProviderApplicability> {
    this.calls.applicable += 1;
    return this.input.applicability;
  }

  async inspect(): Promise<readonly SyncFinding[]> {
    this.calls.inspect += 1;
    if (this.input.inspect_error !== undefined) throw this.input.inspect_error;
    return this.input.findings ?? [];
  }

  async plan(_context: SyncContext, finding_ids: readonly string[]): Promise<readonly SyncActionPlan[]> {
    this.calls.plan += 1;
    if (this.input.plan_error !== undefined) throw this.input.plan_error;
    const selected = new Set(finding_ids);
    return (this.input.actions ?? []).filter((item) =>
      item.finding_ids.some((id) => selected.has(id))
    );
  }

  async apply(action_plan: SyncActionPlan, _confirmation: SyncApplyConfirmation): Promise<SyncActionReceipt> {
    this.calls.apply += 1;
    void _confirmation;
    const applyError = this.input.apply_errors?.[action_plan.action_id] ?? this.input.apply_error;
    if (applyError !== undefined) throw applyError;
    const receipt = this.input.receipts?.[action_plan.action_id];
    if (receipt === undefined) throw new Error(`missing receipt for ${action_plan.action_id}`);
    return receipt;
  }

  async verify(receipt: SyncActionReceipt): Promise<SyncVerification> {
    this.calls.verify += 1;
    const verifyError = this.input.verify_errors?.[receipt.action_id] ?? this.input.verify_error;
    if (verifyError !== undefined) throw verifyError;
    const verification = this.input.verifications?.[receipt.action_id];
    if (verification === undefined) throw new Error(`missing verification for ${receipt.action_id}`);
    return verification;
  }

  async rollback(action_plan: SyncActionPlan, _receipt: SyncActionReceipt): Promise<SyncRollbackReceipt> {
    this.calls.rollback += 1;
    void _receipt;
    const rollbackError = this.input.rollback_errors?.[action_plan.action_id];
    if (rollbackError !== undefined) throw rollbackError;
    const rollbackReceipt = this.input.rollback_receipts?.[action_plan.action_id];
    if (rollbackReceipt === undefined) throw new Error(`missing rollback receipt for ${action_plan.action_id}`);
    return rollbackReceipt;
  }
}
