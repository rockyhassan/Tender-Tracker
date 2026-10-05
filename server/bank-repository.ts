import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { BankProfile, CreateEmailTemplateInput, EmailTemplate, EmailTemplateType, UpdateEmailTemplateInput } from "../shared/bank-domain";

interface BankRow { id: number; account_name: string; account_number_ciphertext: string; branch: string; created_at: string; updated_at: string; }
interface TemplateRow { id: string; type: EmailTemplateType; name: string; company_id: string | null; company_name: string | null; email_to: string; email_cc: string | null; subject: string; selected: number; created_at: string; updated_at: string; }

const toBankProfile = (row: BankRow): BankProfile => ({ id: 1, accountName: row.account_name, accountNumberMasked: maskAccountNumber(row.account_number_ciphertext), branch: row.branch, createdAt: row.created_at, updatedAt: row.updated_at });
const toTemplate = (row: TemplateRow): EmailTemplate => ({ id: row.id, type: row.type, name: row.name, companyId: row.company_id ?? undefined, companyName: row.company_name ?? undefined, to: row.email_to, cc: row.email_cc ?? undefined, subject: row.subject, selected: Boolean(row.selected), createdAt: row.created_at, updatedAt: row.updated_at });

/** Returns a stable redacted form without exposing the encrypted value or account number. */
export function maskAccountNumber(value: string): string {
  const visible = value.slice(-4);
  return `${"•".repeat(Math.max(4, Math.min(10, value.length - visible.length)))}${visible}`;
}

export interface BankRepository {
  getProfile(): Promise<BankProfile | undefined> | BankProfile | undefined;
  getProfileCiphertext(): Promise<string | undefined> | string | undefined;
  saveProfile(input: { accountName: string; accountNumberCiphertext: string; branch: string }): Promise<BankProfile> | BankProfile;
  listTemplates(): Promise<EmailTemplate[]> | EmailTemplate[];
  findTemplate(id: string): Promise<EmailTemplate | undefined> | EmailTemplate | undefined;
  createTemplate(input: CreateEmailTemplateInput & { id?: string }): Promise<EmailTemplate> | EmailTemplate;
  updateTemplate(id: string, changes: UpdateEmailTemplateInput): Promise<EmailTemplate | undefined> | EmailTemplate | undefined;
  selectTemplate(id: string): Promise<EmailTemplate | undefined> | EmailTemplate | undefined;
  deleteTemplate(id: string): Promise<boolean> | boolean;
}

export class SqliteBankRepository implements BankRepository {
  constructor(private readonly database: DatabaseSync) {}

  getProfile(): BankProfile | undefined {
    const row = this.database.prepare("SELECT id, account_name, account_number_ciphertext, branch, created_at, updated_at FROM bank_profiles WHERE id = 1").get() as BankRow | undefined;
    return row ? toBankProfile(row) : undefined;
  }

  getProfileCiphertext(): string | undefined {
    const row = this.database.prepare("SELECT account_number_ciphertext FROM bank_profiles WHERE id = 1").get() as { account_number_ciphertext: string } | undefined;
    return row?.account_number_ciphertext;
  }

  saveProfile(input: { accountName: string; accountNumberCiphertext: string; branch: string }): BankProfile {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO bank_profiles (id, account_name, account_number_ciphertext, branch, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET account_name = excluded.account_name, account_number_ciphertext = excluded.account_number_ciphertext, branch = excluded.branch, updated_at = excluded.updated_at
    `).run(input.accountName.trim(), input.accountNumberCiphertext, input.branch.trim(), now, now);
    return this.getProfile()!;
  }

  listTemplates(): EmailTemplate[] {
    const rows = this.database.prepare(`
      SELECT e.id, e.type, e.name, e.company_id, c.name AS company_name,
             e.email_to, e.email_cc, e.subject, e.selected, e.created_at, e.updated_at
      FROM email_templates e
      LEFT JOIN companies c ON c.id = e.company_id
      ORDER BY e.type, e.company_id, e.name COLLATE NOCASE, e.id
    `).all() as unknown as TemplateRow[];
    return rows.map(toTemplate);
  }

  findTemplate(id: string): EmailTemplate | undefined { return this.listTemplates().find((template) => template.id === id); }

  createTemplate(input: CreateEmailTemplateInput & { id?: string }): EmailTemplate {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO email_templates (id, type, name, company_id, email_to, email_cc, subject, selected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, input.type, input.name.trim(), input.companyId ?? null, input.to.trim(), input.cc?.trim() || null, input.subject.trim(), now, now);
    if (input.id && this.findTemplate(id)) return this.findTemplate(id)!;
    return this.findTemplate(id)!;
  }

  updateTemplate(id: string, changes: UpdateEmailTemplateInput): EmailTemplate | undefined {
    if (!this.findTemplate(id)) return undefined;
    const fields: Array<[string, SQLOutputValue]> = [];
    if (changes.type !== undefined) fields.push(["type", changes.type]);
    if (changes.name !== undefined) fields.push(["name", changes.name.trim()]);
    if (changes.companyId !== undefined) fields.push(["company_id", changes.companyId ?? null]);
    if (changes.to !== undefined) fields.push(["email_to", changes.to.trim()]);
    if (changes.cc !== undefined) fields.push(["email_cc", changes.cc?.trim() || null]);
    if (changes.subject !== undefined) fields.push(["subject", changes.subject.trim()]);
    if (changes.selected !== undefined) fields.push(["selected", changes.selected ? 1 : 0]);
    fields.push(["updated_at", new Date().toISOString()]);
    this.database.prepare(`UPDATE email_templates SET ${fields.map(([field]) => `${field} = ?`).join(", ")} WHERE id = ?`).run(...fields.map(([, value]) => value), id);
    return this.findTemplate(id);
  }

  selectTemplate(id: string): EmailTemplate | undefined {
    const template = this.findTemplate(id);
    if (!template) return undefined;
    const now = new Date().toISOString();
    this.database.exec("BEGIN");
    try {
      this.database.prepare("UPDATE email_templates SET selected = 0, updated_at = ? WHERE type = ? AND ((company_id IS NULL AND ? IS NULL) OR company_id = ?)").run(now, template.type, template.companyId ?? null, template.companyId ?? null);
      this.database.prepare("UPDATE email_templates SET selected = 1, updated_at = ? WHERE id = ?").run(now, id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.findTemplate(id);
  }

  deleteTemplate(id: string): boolean { return this.database.prepare("DELETE FROM email_templates WHERE id = ?").run(id).changes > 0; }
}

export { PgBankRepository } from "./pg-bank-repository";
