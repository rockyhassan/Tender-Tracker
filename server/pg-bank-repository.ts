import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  BankProfile,
  CreateEmailTemplateInput,
  EmailTemplate,
  EmailTemplateType,
  UpdateEmailTemplateInput,
} from "../shared/bank-domain";
import { maskAccountNumber } from "./bank-repository";

interface BankRow {
  id: number;
  account_name: string;
  account_number_ciphertext: string;
  branch: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface TemplateRow {
  id: string;
  type: EmailTemplateType;
  name: string;
  company_id: string | null;
  company_name: string | null;
  email_to: string;
  email_cc: string | null;
  subject: string;
  selected: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

const toIso = (val: unknown): string | undefined => {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

const toBankProfile = (row: BankRow): BankProfile => ({
  id: 1,
  accountName: row.account_name,
  accountNumberMasked: maskAccountNumber(row.account_number_ciphertext),
  branch: row.branch,
  createdAt: toIso(row.created_at)!,
  updatedAt: toIso(row.updated_at)!,
});

const toTemplate = (row: TemplateRow): EmailTemplate => ({
  id: row.id,
  type: row.type,
  name: row.name,
  companyId: row.company_id ?? undefined,
  companyName: row.company_name ?? undefined,
  to: row.email_to,
  cc: row.email_cc ?? undefined,
  subject: row.subject,
  selected: Boolean(row.selected),
  createdAt: toIso(row.created_at)!,
  updatedAt: toIso(row.updated_at)!,
});

export class PgBankRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getProfile(): Promise<BankProfile | undefined> {
    const res = await this.pool.query<BankRow>(
      "SELECT id, account_name, account_number_ciphertext, branch, created_at, updated_at FROM bank_profiles WHERE id = 1"
    );
    return res.rows[0] ? toBankProfile(res.rows[0]) : undefined;
  }

  async getProfileCiphertext(): Promise<string | undefined> {
    const res = await this.pool.query<{ account_number_ciphertext: string }>(
      "SELECT account_number_ciphertext FROM bank_profiles WHERE id = 1"
    );
    return res.rows[0]?.account_number_ciphertext;
  }

  async saveProfile(input: { accountName: string; accountNumberCiphertext: string; branch: string }): Promise<BankProfile> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO bank_profiles (id, account_name, account_number_ciphertext, branch, created_at, updated_at)
       VALUES (1, $1, $2, $3, $4, $5)
       ON CONFLICT(id) DO UPDATE SET
         account_name = EXCLUDED.account_name,
         account_number_ciphertext = EXCLUDED.account_number_ciphertext,
         branch = EXCLUDED.branch,
         updated_at = EXCLUDED.updated_at`,
      [input.accountName.trim(), input.accountNumberCiphertext, input.branch.trim(), now, now]
    );
    return (await this.getProfile())!;
  }

  async listTemplates(): Promise<EmailTemplate[]> {
    const sql = `
      SELECT e.id, e.type, e.name, e.company_id, c.name AS company_name,
             e.email_to, e.email_cc, e.subject, e.selected, e.created_at, e.updated_at
      FROM email_templates e
      LEFT JOIN companies c ON c.id = e.company_id
      ORDER BY e.type, e.company_id, LOWER(e.name), e.id
    `;
    const res = await this.pool.query<TemplateRow>(sql);
    return res.rows.map(toTemplate);
  }

  async findTemplate(id: string): Promise<EmailTemplate | undefined> {
    const templates = await this.listTemplates();
    return templates.find((t) => t.id === id);
  }

  async createTemplate(input: CreateEmailTemplateInput & { id?: string }): Promise<EmailTemplate> {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO email_templates (id, type, name, company_id, email_to, email_cc, subject, selected, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)`,
      [
        id,
        input.type,
        input.name.trim(),
        input.companyId ?? null,
        input.to.trim(),
        input.cc?.trim() || null,
        input.subject.trim(),
        now,
        now,
      ]
    );
    return (await this.findTemplate(id))!;
  }

  async updateTemplate(id: string, changes: UpdateEmailTemplateInput): Promise<EmailTemplate | undefined> {
    const existing = await this.findTemplate(id);
    if (!existing) return undefined;

    const fields: Array<[string, any]> = [];
    if (changes.type !== undefined) fields.push(["type", changes.type]);
    if (changes.name !== undefined) fields.push(["name", changes.name.trim()]);
    if (changes.companyId !== undefined) fields.push(["company_id", changes.companyId ?? null]);
    if (changes.to !== undefined) fields.push(["email_to", changes.to.trim()]);
    if (changes.cc !== undefined) fields.push(["email_cc", changes.cc?.trim() || null]);
    if (changes.subject !== undefined) fields.push(["subject", changes.subject.trim()]);
    if (changes.selected !== undefined) fields.push(["selected", Boolean(changes.selected)]);

    fields.push(["updated_at", new Date().toISOString()]);
    const assignments = fields.map(([field], idx) => `"${field}" = $${idx + 1}`).join(", ");
    await this.pool.query(
      `UPDATE email_templates SET ${assignments} WHERE id = $${fields.length + 1}`,
      [...fields.map(([, val]) => val), id]
    );
    return await this.findTemplate(id);
  }

  async selectTemplate(id: string): Promise<EmailTemplate | undefined> {
    const template = await this.findTemplate(id);
    if (!template) return undefined;

    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE email_templates SET selected = false, updated_at = $1 WHERE type = $2 AND ((company_id IS NULL AND $3::text IS NULL) OR company_id = $3)",
        [now, template.type, template.companyId ?? null]
      );
      await client.query("UPDATE email_templates SET selected = true, updated_at = $1 WHERE id = $2", [now, id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return await this.findTemplate(id);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM email_templates WHERE id = $1", [id]);
    return Number(res.rowCount ?? 0) > 0;
  }
}
