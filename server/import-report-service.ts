import type { DatabaseSync } from "node:sqlite";
import type pg from "pg";
import * as XLSX from "xlsx";
import {
  createTenderSchema,
  workflowStages,
  tenderStatuses,
  type CreateTenderInput,
  type Tender as TenderModel,
  type WorkflowStage,
  type TenderStatus,
} from "../shared/domain";
import type { TenderRepository } from "./repository";
import type { TenderService } from "./service";

export type DuplicateDecision = "replace" | "keep-both" | "skip" | "keep-old";

export interface ImportPreviewRow {
  rowIndex: number;
  tender: CreateTenderInput;
  valid: boolean;
  errors: string[];
  duplicateOf?: TenderModel;
  duplicateRow?: number;
}

export interface ImportPreview {
  filename?: string;
  rows: ImportPreviewRow[];
  duplicates: ImportPreviewRow[];
  validCount: number;
  invalidCount: number;
}

export interface ReportData {
  title: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

const key = (value?: string) => value?.trim().toLowerCase();
const text = (value: unknown): string => (value == null ? "" : String(value).trim());
const dateValue = (value: unknown): string => {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const raw = String(value).trim();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
};

const numberValue = (value: unknown): number | undefined => {
  if (value == null || value === "") return undefined;
  const cleaned = String(value).replace(/,/g, "").trim();
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const normalizeRow = (raw: Record<string, unknown>): CreateTenderInput => {
  const output: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const normalizedKey = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    output[normalizedKey] = v;
  }
  const stage = text(output.stage);
  const status = text(output.status);
  return {
    tenderId: text(output.tenderid || output.tenderno || output.id),
    company: text(output.company || output.companyname || output.contractor),
    authority: text(output.authority || output.organization || output.client),
    authorityZone: text(output.authorityzone || output.zone || output.region) || undefined,
    packageName: text(output.packagename || output.package || output.workname || output.title),
    closingAt: dateValue(output.closingat || output.closingdate || output.closing),
    submissionAt: dateValue(output.submissionat || output.submissiondate || output.submission) || undefined,
    tenderValue: numberValue(output.tendervalue || output.value || output.estimatedvalue),
    submittedValue: numberValue(output.submittedvalue || output.quotedvalue || output.quotedamount),
    stage: (workflowStages.includes(stage as WorkflowStage) ? stage : "New") as WorkflowStage,
    status: (tenderStatuses.includes(status as TenderStatus) ? status : "Draft") as TenderStatus,
    issueBatchId: text(output.issuebatchid) || undefined,
  };
};

export class ImportReportService {
  constructor(
    private readonly tenders: TenderRepository,
    private readonly service: TenderService,
    private readonly database?: DatabaseSync | pg.Pool
  ) {}

  async preview(input: { filename?: string; data?: string; rows?: Record<string, unknown>[] }): Promise<ImportPreview> {
    let rows = input.rows;
    if (!rows && input.data) {
      const buffer = Buffer.from(input.data.replace(/^data:[^;]+;base64,/, ""), "base64");
      const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    }
    if (!rows?.length) return { filename: input.filename, rows: [], duplicates: [], validCount: 0, invalidCount: 0 };
    const allTenders = await this.tenders.list();
    const existingById = new Map(allTenders.map((item) => [key(item.tenderId), item]));
    const seen = new Map<string, number>();
    const previewRows = rows.map((raw, index) => {
      const tender = normalizeRow(raw);
      const parsed = createTenderSchema.safeParse(tender);
      const errors = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`);
      const normalizedId = key(tender.tenderId);
      const duplicateOf = normalizedId ? existingById.get(normalizedId) : undefined;
      const duplicateRow = normalizedId ? seen.get(normalizedId) : undefined;
      if (normalizedId) seen.set(normalizedId, index + 2);
      return { rowIndex: index + 2, tender, valid: errors.length === 0, errors, duplicateOf, duplicateRow };
    });
    const duplicates = previewRows.filter((row) => row.duplicateOf || row.duplicateRow);
    return {
      filename: input.filename,
      rows: previewRows,
      duplicates,
      validCount: previewRows.filter((row) => row.valid).length,
      invalidCount: previewRows.filter((row) => !row.valid).length,
    };
  }

  async commit(preview: ImportPreview, decisions: Record<string, DuplicateDecision> = {}) {
    const imported: TenderModel[] = [];
    const skipped: number[] = [];
    const updated: TenderModel[] = [];
    const errors: Array<{ rowIndex: number; error: string }> = [];
    const byRow = new Map(preview.rows.map((row) => [row.rowIndex, row]));

    for (const row of preview.rows) {
      if (!row.valid || !row.tender.tenderId) {
        if (!row.valid) errors.push({ rowIndex: row.rowIndex, error: row.errors.join("; ") });
        continue;
      }
      const decision = decisions[String(row.rowIndex)] ?? (row.duplicateOf || row.duplicateRow ? "skip" : "keep-both");
      if ((row.duplicateOf || row.duplicateRow) && (decision === "keep-old" || decision === "skip")) {
        skipped.push(row.rowIndex);
        continue;
      }
      try {
        if (decision === "replace" && row.duplicateOf) {
          const result = await this.service.update(row.duplicateOf.id, row.tender);
          if (result) updated.push(result);
          else errors.push({ rowIndex: row.rowIndex, error: "Existing tender no longer exists" });
        } else {
          const result = await this.service.create(row.tender);
          imported.push(result);
        }
      } catch (error) {
        errors.push({ rowIndex: row.rowIndex, error: error instanceof Error ? error.message : "Unable to import row" });
      }
    }
    void byRow;
    return { imported, updated, skipped, errors, total: imported.length + updated.length };
  }

  async report(type: string, rawQuery: unknown = {}): Promise<ReportData> {
    const query =
      rawQuery && typeof rawQuery === "object"
        ? Object.fromEntries(Object.entries(rawQuery as Record<string, unknown>).filter(([, value]) => typeof value === "string" && value !== ""))
        : {};
    const tenders = Object.keys(query).length ? await this.service.list(query) : await this.tenders.list();

    const isPg = Boolean(this.database && "query" in this.database);

    const getDetails = async (id: string) => {
      if (isPg) {
        const pool = this.database as pg.Pool;
        const charges = (await pool.query("SELECT * FROM charges WHERE tender_id = $1 ORDER BY charged_at DESC", [id])).rows;
        const payOrders = (await pool.query("SELECT * FROM pay_orders WHERE tender_id = $1 ORDER BY issued_at DESC", [id])).rows;
        const securities = (await pool.query("SELECT * FROM performance_securities WHERE tender_id = $1 ORDER BY expires_at ASC", [id])).rows;
        const result = (await pool.query("SELECT * FROM results WHERE tender_id = $1 ORDER BY updated_at DESC LIMIT 1", [id])).rows[0];
        return { charges, payOrders, securities, result };
      }
      if (this.database) {
        const db = this.database as DatabaseSync;
        const charges = db.prepare("SELECT * FROM charges WHERE tender_id = ? ORDER BY charged_at DESC").all(id) as Array<Record<string, any>>;
        const payOrders = db.prepare("SELECT * FROM pay_orders WHERE tender_id = ? ORDER BY issued_at DESC").all(id) as Array<Record<string, any>>;
        const securities = db.prepare("SELECT * FROM performance_securities WHERE tender_id = ? ORDER BY expires_at ASC").all(id) as Array<Record<string, any>>;
        const result = db.prepare("SELECT * FROM results WHERE tender_id = ? ORDER BY updated_at DESC LIMIT 1").get(id) as Record<string, any> | undefined;
        return { charges, payOrders, securities, result };
      }
      return { charges: [], payOrders: [], securities: [], result: undefined };
    };

    if (type === "tender-list") {
      return {
        title: "Tender List",
        columns: ["Tender ID", "Company", "Authority", "Package", "Closing", "Submission", "Tender Value", "Submitted Value", "Stage", "Status"],
        rows: tenders.map((t) => ({
          "Tender ID": t.tenderId,
          Company: t.company,
          Authority: t.authority,
          Package: t.packageName,
          Closing: t.closingAt,
          Submission: t.submissionAt ?? "",
          "Tender Value": t.tenderValue ?? null,
          "Submitted Value": t.submittedValue ?? "",
          Stage: t.stage,
          Status: t.status,
        })),
      };
    }
    if (type === "pending-deadline") {
      const now = Date.now();
      return {
        title: "Pending Deadline",
        columns: ["Tender ID", "Company", "Deadline", "Hours Remaining", "Stage"],
        rows: tenders
          .filter(
            (t) =>
              t.status !== "Closed" &&
              Date.parse((t.stage === "Purchased" || t.stage === "Submitted") ? (t.submissionAt ?? t.closingAt) : t.closingAt) >= now
          )
          .sort(
            (a, b) =>
              Date.parse((a.stage === "Purchased" || a.stage === "Submitted") ? (a.submissionAt ?? a.closingAt) : a.closingAt) -
              Date.parse((b.stage === "Purchased" || b.stage === "Submitted") ? (b.submissionAt ?? b.closingAt) : b.closingAt)
          )
          .map((t) => ({
            "Tender ID": t.tenderId,
            Company: t.company,
            Deadline: (t.stage === "Purchased" || t.stage === "Submitted") ? (t.submissionAt ?? t.closingAt) : t.closingAt,
            "Hours Remaining":
              Math.round(
                (Date.parse((t.stage === "Purchased" || t.stage === "Submitted") ? (t.submissionAt ?? t.closingAt) : t.closingAt) - now) / 360000
              ) / 10,
            Stage: t.stage,
          })),
      };
    }

    const detailsMap = new Map<string, any>();
    for (const t of tenders) {
      detailsMap.set(t.id, await getDetails(t.id));
    }
    const details = (id: string) => detailsMap.get(id);

    if (type === "bank-charge") {
      return this.flatten(type, "Bank Charge", ["Tender ID", "Company", "Charge Type", "Amount", "Charged At", "Reference"], tenders, details, (t, d) =>
        d.charges.map((r: Record<string, any>) => ({
          "Tender ID": t.tenderId,
          Company: t.company,
          "Charge Type": r.type,
          Amount: Number(r.amount),
          "Charged At": r.charged_at instanceof Date ? r.charged_at.toISOString() : r.charged_at,
          Reference: r.reference ?? "",
        }))
      );
    }
    if (type === "pay-order") {
      return this.flatten(
        type,
        "Pay Order",
        ["Tender ID", "Company", "Order Number", "Amount", "Payee", "Issued At", "Return Due", StatusKey("Status")],
        tenders,
        details,
        (t, d) =>
          d.payOrders.map((r: Record<string, any>) => ({
            "Tender ID": t.tenderId,
            Company: t.company,
            "Order Number": r.order_number,
            Amount: Number(r.amount),
            Payee: r.payee,
            "Issued At": r.issued_at instanceof Date ? r.issued_at.toISOString() : r.issued_at,
            "Return Due": r.return_due_at ? (r.return_due_at instanceof Date ? r.return_due_at.toISOString() : r.return_due_at) : "",
            Status: r.return_status ?? r.status,
          }))
      );
    }
    if (type === "performance-security") {
      return this.flatten(
        type,
        "Performance Security",
        ["Tender ID", "Company", "Security Number", "Amount", "Issued At", "Expires At", "Return Date", "Return Status", "Return Remarks", "Provider", StatusKey("Status"), "Remarks"],
        tenders,
        details,
        (t, d) =>
          d.securities.map((r: Record<string, any>) => ({
            "Tender ID": t.tenderId,
            Company: t.company,
            "Security Number": r.security_number,
            Amount: Number(r.amount),
            "Issued At": r.issued_at instanceof Date ? r.issued_at.toISOString() : r.issued_at,
            "Expires At": r.expires_at instanceof Date ? r.expires_at.toISOString() : r.expires_at,
            "Return Date": r.return_date ? (r.return_date instanceof Date ? r.return_date.toISOString() : r.return_date) : "",
            "Return Status": r.return_status ?? "",
            "Return Remarks": r.return_remarks ?? "",
            Provider: r.provider ?? "",
            Status: r.status,
            Remarks: r.remarks ?? "",
          }))
      );
    }
    if (type === "win-lost") {
      return {
        title: "Win / Lost",
        columns: ["Tender ID", "Company", "Outcome", "Result Date", "Quoted Amount", "Awarded Company", "Remarks"],
        rows: tenders.flatMap((t) => {
          const r = details(t.id).result;
          return r
            ? [
                {
                  "Tender ID": t.tenderId,
                  Company: t.company,
                  Outcome: r.outcome,
                  "Result Date": r.result_date ? (r.result_date instanceof Date ? r.result_date.toISOString() : r.result_date) : "",
                  "Quoted Amount": r.quoted_amount ?? "",
                  "Awarded Company": r.awarded_company ?? "",
                  Remarks: r.remarks ?? "",
                },
              ]
            : [];
        }),
      };
    }
    if (type === "tender-cost") {
      return {
        title: "Tender Cost",
        columns: ["Tender ID", "Company", "Tender Value", "Charge Count", "Total Charges", "Pay Order Total", "Total Cost"],
        rows: tenders.map((t) => {
          const d = details(t.id);
          const charges = d.charges.reduce((sum: number, r: Record<string, any>) => sum + Number(r.amount), 0);
          const payOrders = d.payOrders.reduce((sum: number, r: Record<string, any>) => sum + Number(r.amount), 0);
          return {
            "Tender ID": t.tenderId,
            Company: t.company,
            "Tender Value": t.tenderValue ?? null,
            "Charge Count": d.charges.length,
            "Total Charges": charges,
            "Pay Order Total": payOrders,
            "Total Cost": charges + payOrders,
          };
        }),
      };
    }
    throw new Error("Unknown report type");
  }

  private flatten(_type: string, title: string, columns: string[], tenders: TenderModel[], details: (id: string) => any, map: (t: TenderModel, d: any) => Array<Record<string, unknown>>) {
    return { title, columns, rows: tenders.flatMap((t) => map(t, details(t.id))) };
  }
}

const StatusKey = (value: string) => value;
export const csvEscape = (value: unknown) => {
  const stringValue = value == null ? "" : String(value);
  return /[",\n]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
};
export const reportCsv = (report: Awaited<ReturnType<ImportReportService["report"]>>) =>
  [report.columns.map(csvEscape).join(","), ...report.rows.map((row) => report.columns.map((column) => csvEscape(row[column])).join(","))].join("\n") + "\n";
export const reportHtml = (report: Awaited<ReturnType<ImportReportService["report"]>>) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${report.title}</title><style>body{font:14px Arial;color:#182b32;padding:28px}h1{font-size:22px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd7d4;padding:7px;text-align:left}th{background:#edf4f1}@media print{button{display:none}}</style></head><body><button onclick="print()">Print / Save as PDF</button><h1>${report.title}</h1><p>Generated ${new Date().toLocaleString()}</p><table><thead><tr>${report.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${report.rows.map((row) => `<tr>${report.columns.map((c) => `<td>${escapeHtml(row[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character] ?? character));
