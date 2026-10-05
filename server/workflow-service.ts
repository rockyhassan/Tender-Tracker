import {
  createIssueBatchSchema,
  createIssueBatchWithTendersSchema,
  createPurchaseSheetSchema,
  issueBatchListQuerySchema,
  updateIssueBatchSchema,
  updatePurchaseSheetSchema,
  purchaseSheetListQuerySchema,
  type CreateIssueBatchInput,
  type CreateIssueBatchWithTendersInput,
  type CreatePurchaseSheetInput,
  type IssueBatch,
  type IssueBatchListQuery,
  type IssueBatchWithTendersResult,
  type PurchaseSheet,
  type PurchaseSheetListQuery,
  type UpdateIssueBatchInput,
  type UpdatePurchaseSheetInput,
} from "../shared/domain";
import type { ZodIssue } from "zod";
import type { TenderRepository } from "./repository";
import type { IssueBatchRepository, PurchaseSheetRepository } from "./workflow-repository";
import type { Authority } from "../shared/domain";

export class WorkflowValidationError extends Error {
  constructor(public readonly issues: ZodIssue[]) {
    super("Issue batch or purchase sheet validation failed");
    this.name = "WorkflowValidationError";
  }
}

const parseOrThrow = <T>(result: { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } }): T => {
  if (!result.success) throw new WorkflowValidationError(result.error.issues);
  return result.data;
};

export class WorkflowService {
  constructor(
    private readonly batches: IssueBatchRepository,
    private readonly sheets: PurchaseSheetRepository,
    private readonly tenders: TenderRepository,
    private readonly authorities?: { get(id: string): Promise<Authority | undefined> | Authority | undefined }
  ) {}

  async listBatches(rawQuery: unknown = {}): Promise<IssueBatch[]> {
    return await this.batches.list(parseOrThrow<IssueBatchListQuery>(issueBatchListQuerySchema.safeParse(rawQuery)));
  }

  async getBatch(id: string): Promise<IssueBatch | undefined> {
    return await this.batches.findById(id);
  }

  async createBatch(rawInput: unknown): Promise<IssueBatch> {
    const input = parseOrThrow<CreateIssueBatchInput>(createIssueBatchSchema.safeParse(rawInput));
    const authority = await this.authorities?.get(input.authorityId);
    if (!authority) throw new WorkflowValidationError([{ code: "custom", path: ["authorityId"], message: "Select a saved authority profile" }]);
    return await this.batches.create({
      ...input,
      authorityName: authority.name,
      authorityZone: authority.zone ?? input.authorityZone ?? "",
      issueDate: new Date(input.issueDate).toISOString(),
    });
  }

  async createBatchWithTenders(rawInput: unknown): Promise<IssueBatchWithTendersResult> {
    const input = parseOrThrow<CreateIssueBatchWithTendersInput>(createIssueBatchWithTendersSchema.safeParse(rawInput));
    const seen = new Set<string>();
    const issues: ZodIssue[] = [];

    for (let index = 0; index < input.rows.length; index++) {
      const row = input.rows[index];
      const normalized = row.tenderId.trim().toLowerCase();
      const existing = await this.tenders.findByTenderId(row.tenderId);
      if (seen.has(normalized) || existing) {
        issues.push({ code: "custom", path: ["rows", index, "tenderId"], message: "Tender ID already exists in this batch or register" });
      }
      seen.add(normalized);
    }
    if (issues.length) throw new WorkflowValidationError(issues);

    const authority = await this.authorities?.get(input.authorityId);
    if (!authority) throw new WorkflowValidationError([{ code: "custom", path: ["authorityId"], message: "Select a saved authority profile" }]);

    return await this.batches.createWithTenders({
      ...input,
      authorityName: authority.name,
      issueDate: new Date(input.issueDate).toISOString(),
      authorityZone: authority.zone ?? input.authorityZone ?? "",
      rows: input.rows.map((row) => ({
        ...row,
        tenderId: row.tenderId.trim(),
        packageName: row.packageName.trim(),
        closingAt: new Date(row.closingAt).toISOString(),
        submissionAt: row.submissionAt ? new Date(row.submissionAt).toISOString() : undefined,
      })),
    });
  }

  async updateBatch(id: string, rawInput: unknown): Promise<IssueBatch | undefined> {
    const input = parseOrThrow<UpdateIssueBatchInput>(updateIssueBatchSchema.safeParse(rawInput));
    if (input.authorityId !== undefined) {
      const authority = await this.authorities?.get(input.authorityId);
      if (!authority) throw new WorkflowValidationError([{ code: "custom", path: ["authorityId"], message: "Select a saved authority profile" }]);
      input.authorityZone = authority.zone ?? input.authorityZone ?? "";
    }
    return await this.batches.update(id, input);
  }

  async deleteBatch(id: string): Promise<boolean> {
    return await this.batches.delete(id);
  }

  private async validateSelectedLines(issueBatchId: string, selectedTenderIds: string[], currentSheetId?: string): Promise<void> {
    if (new Set(selectedTenderIds).size !== selectedTenderIds.length) {
      throw new WorkflowValidationError([{ code: "custom", path: ["selectedTenderIds"], message: "Selected tender lines must be unique" }]);
    }
    for (const tenderId of selectedTenderIds) {
      const tender = await this.tenders.findById(tenderId);
      if (!tender) throw new WorkflowValidationError([{ code: "custom", path: ["selectedTenderIds"], message: `Tender ${tenderId} was not found` }]);
      if (tender.issueBatchId && tender.issueBatchId !== issueBatchId) {
        throw new WorkflowValidationError([{ code: "custom", path: ["selectedTenderIds"], message: `Tender ${tender.tenderId} belongs to another issue batch` }]);
      }
      const assigned = await this.sheets.findSheetForTender(tenderId, currentSheetId);
      if (assigned) {
        const sheetLabel = assigned.sheetNumber ? `Purchase Sheet #${assigned.sheetNumber}` : "another Purchase Sheet";
        throw new WorkflowValidationError([{ code: "custom", path: ["selectedTenderIds"], message: `Tender ${tender.tenderId} is already assigned to ${sheetLabel}` }]);
      }
    }
  }

  async listSheets(rawQuery: unknown = {}): Promise<PurchaseSheet[]> {
    return await this.sheets.list(parseOrThrow<PurchaseSheetListQuery>(purchaseSheetListQuerySchema.safeParse(rawQuery)));
  }

  async getSheet(id: string): Promise<PurchaseSheet | undefined> {
    return await this.sheets.findById(id);
  }

  async createSheet(rawInput: unknown): Promise<PurchaseSheet> {
    const input = parseOrThrow<CreatePurchaseSheetInput>(createPurchaseSheetSchema.safeParse(rawInput));
    const batch = await this.batches.findById(input.issueBatchId);
    if (!batch) throw new WorkflowValidationError([{ code: "custom", path: ["issueBatchId"], message: "Issue batch was not found" }]);
    await this.validateSelectedLines(input.issueBatchId, input.selectedTenderIds);
    return await this.sheets.create({
      ...input,
      purchasedAt: input.purchasedAt ? new Date(input.purchasedAt).toISOString() : undefined,
    });
  }

  async updateSheet(id: string, rawInput: unknown): Promise<PurchaseSheet | undefined> {
    const input = parseOrThrow<UpdatePurchaseSheetInput>(updatePurchaseSheetSchema.safeParse(rawInput));
    const existingSheet = await this.sheets.findById(id);
    if (!existingSheet) return undefined;
    const issueBatchId = input.issueBatchId ?? existingSheet.issueBatchId;
    const batch = await this.batches.findById(issueBatchId);
    if (!batch) throw new WorkflowValidationError([{ code: "custom", path: ["issueBatchId"], message: "Issue batch was not found" }]);
    if (input.selectedTenderIds) await this.validateSelectedLines(issueBatchId, input.selectedTenderIds, id);
    return await this.sheets.update(id, {
      ...input,
      issueBatchId,
      purchasedAt: input.purchasedAt ? new Date(input.purchasedAt).toISOString() : input.purchasedAt,
    });
  }

  async deleteSheet(id: string): Promise<boolean> {
    return await this.sheets.delete(id);
  }
}
