import {
  createTenderSchema,
  bulkTenderRowSchema,
  type BulkTenderCreateResult,
  type BulkTenderRowInput,
  type CreateTenderInput,
  type DeadlineSummary,
  type DashboardSummary,
  type PendingWorkItem,
  type PendingWorkSummary,
  type TenderListQuery,
  updateTenderSchema,
  tenderListQuerySchema,
  type UpdateTenderInput,
  type Tender,
  type TenderDetails,
} from "../shared/domain";
import type { ZodIssue } from "zod";
import type { TenderRepository } from "./repository";
import type { IssueBatchRepository } from "./workflow-repository";

export class TenderValidationError extends Error {
  constructor(public readonly issues: ZodIssue[]) {
    super("Tender request validation failed");
    this.name = "TenderValidationError";
  }
}

const parseOrThrow = <T>(result: { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } }): T => {
  if (!result.success) throw new TenderValidationError(result.error.issues);
  return result.data;
};

export class TenderService {
  constructor(
    private readonly repository: TenderRepository,
    private readonly lifecycle?: { details: (id: string) => Promise<TenderDetails | undefined> | TenderDetails | undefined },
    private readonly batches?: Pick<IssueBatchRepository, "findById">
  ) {}

  async list(rawQuery: unknown = {}): Promise<Tender[]> {
    const query = parseOrThrow<TenderListQuery>(tenderListQuerySchema.safeParse(rawQuery));
    return await this.repository.list(query);
  }

  async get(id: string): Promise<Tender | undefined> {
    return await this.repository.findById(id);
  }

  async create(rawInput: unknown): Promise<Tender> {
    const input = parseOrThrow<CreateTenderInput>(createTenderSchema.safeParse(rawInput));
    return await this.repository.create({
      ...(input.clientId ? { id: input.clientId } : {}),
      tenderId: input.tenderId,
      company: input.company ?? "",
      companyId: input.companyId,
      authority: input.authority,
      authorityZone: input.authorityZone,
      issueBatchId: input.issueBatchId,
      packageName: input.packageName,
      closingAt: new Date(input.closingAt).toISOString(),
      submissionAt: input.submissionAt ? new Date(input.submissionAt).toISOString() : undefined,
      tenderValue: input.tenderValue,
      submittedValue: input.submittedValue,
      stage: input.stage,
      status: input.status,
    });
  }

  async bulkCreateForBatch(rawInput: unknown): Promise<BulkTenderCreateResult> {
    const value = rawInput && typeof rawInput === "object" ? (rawInput as { issueBatchId?: unknown; rows?: unknown }) : {};
    const issueBatchId = typeof value.issueBatchId === "string" ? value.issueBatchId.trim() : "";
    const batch = issueBatchId && (await this.batches?.findById(issueBatchId));
    if (!batch) throw new TenderValidationError([{ code: "custom", path: ["issueBatchId"], message: "Issue batch was not found" }]);
    const rawRows = Array.isArray(value.rows) ? value.rows : [];
    if (!rawRows.length || rawRows.length > 500) {
      throw new TenderValidationError([{ code: "custom", path: ["rows"], message: "Provide between 1 and 500 tender rows" }]);
    }
    const errors: BulkTenderCreateResult["errors"] = [];
    const valid: Array<{ rowIndex: number; input: BulkTenderRowInput }> = [];
    const seen = new Set<string>();

    for (let index = 0; index < rawRows.length; index++) {
      const rawRow = rawRows[index];
      const rowIndex = index + 1;
      const parsed = bulkTenderRowSchema.safeParse(rawRow);
      if (!parsed.success) {
        const rawId =
          rawRow && typeof rawRow === "object" && typeof (rawRow as Record<string, unknown>).tenderId === "string"
            ? (rawRow as Record<string, string>).tenderId
            : undefined;
        errors.push({ rowIndex, tenderId: rawId, errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`) });
        continue;
      }
      const normalizedId = parsed.data.tenderId.trim().toLowerCase();
      const existing = await this.repository.findByTenderId(parsed.data.tenderId);
      if (seen.has(normalizedId) || existing) {
        errors.push({ rowIndex, tenderId: parsed.data.tenderId, duplicate: true, errors: ["Tender ID already exists in this batch or register"] });
        continue;
      }
      seen.add(normalizedId);
      valid.push({ rowIndex, input: parsed.data });
    }

    let created: Tender[] = [];
    if (valid.length) {
      try {
        created = await this.repository.createBulk(
          valid.map(({ input }) => ({
            tenderId: input.tenderId.trim(),
            company: input.company?.trim() ?? "",
            authority: batch.authorityName ?? batch.authorityZone,
            authorityZone: batch.authorityZone,
            issueBatchId,
            packageName: input.packageName.trim(),
            closingAt: new Date(input.closingAt).toISOString(),
            submissionAt: input.submissionAt ? new Date(input.submissionAt).toISOString() : undefined,
            tenderValue: input.tenderValue,
            submittedValue: input.submittedValue,
            stage: input.stage,
            status: input.status,
          }))
        );
      } catch (error) {
        errors.push(
          ...valid.map(({ rowIndex, input }) => ({
            rowIndex,
            tenderId: input.tenderId,
            errors: [error instanceof Error ? error.message : "Bulk insert failed"],
          }))
        );
        created = [];
      }
    }
    return { created, errors, total: rawRows.length, createdCount: created.length, rejectedCount: errors.length };
  }

  async update(id: string, rawInput: unknown): Promise<Tender | undefined> {
    const input = parseOrThrow<UpdateTenderInput>(updateTenderSchema.safeParse(rawInput));
    const changes: UpdateTenderInput = { ...input };
    if (input.closingAt) changes.closingAt = new Date(input.closingAt).toISOString();
    if (input.submissionAt !== undefined) changes.submissionAt = input.submissionAt ? new Date(input.submissionAt).toISOString() : undefined;
    return await this.repository.update(id, changes);
  }

  async delete(id: string): Promise<boolean> {
    return await this.repository.delete(id);
  }

  async deadlineSummary(now = new Date()): Promise<DeadlineSummary> {
    const generatedAt = now.toISOString();
    const items: DeadlineSummary["items"] = [];
    const completedStatuses = new Set(["Completed", "Cancelled", "Expired", "Returned"]);
    const add = (tender: Tender, label: string, dueAt: string | undefined, kind: NonNullable<DeadlineSummary["items"][number]["kind"]>) => {
      if (!dueAt) return;
      const hoursUntil = (Date.parse(dueAt) - now.getTime()) / 3_600_000;
      if (!Number.isFinite(hoursUntil) || hoursUntil <= 0) return;
      const urgency: "urgent" | "soon" | "normal" = hoursUntil <= 24 ? "urgent" : hoursUntil <= 72 ? "soon" : "normal";
      items.push({ label, tenderId: tender.tenderId, dueAt, urgency, kind });
    };

    const allTenders = await this.repository.list();
    for (const tender of allTenders.filter((item) => item.status !== "Closed")) {
      if (["New", "Purchase Pending"].includes(tender.stage)) {
        add(tender, "Tender closing", tender.closingAt, "closing");
      } else if (["Purchased", "Submitted"].includes(tender.stage)) {
        add(tender, "Tender submission", tender.submissionAt ?? tender.closingAt, "submission");
      }
      const details = await this.lifecycle?.details(tender.id);
      if (!details) continue;
      const noa = details.noa;
      if (noa && !completedStatuses.has(noa.status ?? "Pending")) add(tender, "NOA acceptance", noa.acceptanceDeadline, "acceptance");
      const security = details.performanceSecurity;
      if (security) {
        const securityCompleted = completedStatuses.has(security.status ?? "Pending") || completedStatuses.has(security.returnStatus ?? "Pending");
        if (!securityCompleted) {
          add(
            tender,
            security.returnDate ? "Performance security return" : "Performance security expiry",
            security.returnDate ?? security.expiresAt,
            security.returnDate ? "performance-security-return" : "security-expiry"
          );
        }
      }
      for (const order of details.payOrders) {
        if (!completedStatuses.has(order.returnStatus ?? order.status ?? "Pending")) {
          add(tender, "Pay Order return", order.returnDueAt ?? order.expiresAt, "pay-order-return");
        }
      }
    }
    items.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));

    return {
      generatedAt,
      items,
      totals: {
        urgent: items.filter((item) => item.urgency === "urgent").length,
        soon: items.filter((item) => item.urgency === "soon").length,
        normal: items.filter((item) => item.urgency === "normal").length,
      },
    };
  }

  async pendingWorkSummary(now = new Date()): Promise<PendingWorkSummary> {
    const generatedAt = now.toISOString();
    const completedStatuses = new Set(["Completed", "Cancelled", "Expired", "Returned"]);
    const sectionKeys = [
      "payOrder",
      "submission",
      "result",
      "noa",
      "performanceSecurity",
      "contractAgreement",
      "payOrderReturn",
      "performanceSecurityReturn",
      "creditCommitmentReturn",
    ];
    const labels: Record<string, string> = {
      payOrder: "Pay Order",
      submission: "Submission",
      result: "Result",
      noa: "NOA",
      performanceSecurity: "Performance Security",
      contractAgreement: "Contract Agreement",
      payOrderReturn: "Pay Order return",
      performanceSecurityReturn: "Performance Security return",
      creditCommitmentReturn: "Credit Commitment return / release",
    };
    const items = new Map<string, PendingWorkItem[]>();
    for (const key of sectionKeys) items.set(key, []);
    const add = (key: string, tender: Tender, dueAt?: string) => {
      if (!dueAt || !Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) <= now.getTime()) return;
      items.get(key)?.push({ tenderId: tender.tenderId, company: tender.company, dueAt, status: "pending" });
    };

    const allTenders = await this.repository.list();
    for (const tender of allTenders.filter((item) => item.status !== "Closed")) {
      const details = await this.lifecycle?.details(tender.id);
      if (!details) continue;
      const due = tender.submissionAt ?? tender.closingAt;
      if (["New", "Purchase Pending"].includes(tender.stage) && !details.payOrders.length) add("payOrder", tender, tender.closingAt);
      if (tender.stage === "Purchased") add("submission", tender, due);
      if (["Submitted", "Result Pending"].includes(tender.stage) && !details.result) add("result", tender, due);
      if (details.result?.outcome === "Won" && !details.noa) add("noa", tender, details.result.resultDate ?? due);
      if (details.noa && !completedStatuses.has(details.noa.status ?? "Pending") && !details.performanceSecurity) {
        add("performanceSecurity", tender, details.noa.acceptanceDeadline);
      }
      const security = details.performanceSecurity;
      if (security) {
        const securityCompleted = completedStatuses.has(security.status ?? "Pending") || completedStatuses.has(security.returnStatus ?? "Pending");
        if (!securityCompleted && security.returnDate) add("performanceSecurityReturn", tender, security.returnDate);
        if (!securityCompleted && !details.contractAgreement) add("contractAgreement", tender, security.expiresAt);
      }
      for (const order of details.payOrders) {
        if (!completedStatuses.has(order.returnStatus ?? order.status ?? "Pending")) {
          add("payOrderReturn", tender, order.returnDueAt ?? order.expiresAt);
        }
      }
      for (const certificate of details.creditCommitmentCertificates) {
        if (!completedStatuses.has(certificate.status ?? "Pending")) {
          add("creditCommitmentReturn", tender, certificate.returnDate ?? certificate.expiresAt);
        }
      }
    }
    const sections = sectionKeys.map((key) => ({ key, label: labels[key], count: items.get(key)!.length, items: items.get(key)! }));
    const counts = Object.fromEntries(sections.map((section) => [section.key, section.count]));
    counts.creditCommitmentRelease = counts.creditCommitmentReturn;
    return { generatedAt, total: sections.reduce((sum, section) => sum + section.count, 0), counts, sections };
  }

  async dashboardSummary(now = new Date()): Promise<DashboardSummary> {
    const deadline = await this.deadlineSummary(now);
    const pendingWork = await this.pendingWorkSummary(now);
    return { ...deadline, pendingWork };
  }
}
