import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type pg from "pg";
import type { Company } from "../shared/domain";

type CompanyRow = {
  id: string;
  name: string;
  code: string | null;
  contact: string | null;
  notes: string | null;
  archived_at: string | Date | null;
  tender_username_ciphertext?: string | null;
  tender_password_ciphertext?: string | null;
  updated_at: string | Date;
  created_at: string | Date;
};

const toIso = (val: unknown): string | undefined => {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

const toCompany = (row: CompanyRow): Company => ({
  id: row.id,
  name: row.name,
  code: row.code ?? undefined,
  contact: row.contact ?? undefined,
  notes: row.notes ?? undefined,
  archivedAt: toIso(row.archived_at),
  createdAt: toIso(row.created_at)!,
  updatedAt: toIso(row.updated_at)!,
});

export interface CompanyRepository {
  list(includeArchived?: boolean): Promise<Company[]> | Company[];
  findById(id: string): Promise<Company | undefined> | Company | undefined;
  findByName?(name: string): Promise<Company | undefined> | Company | undefined;
  create(input: Omit<Company, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Company> | Company;
  update(id: string, changes: Partial<Omit<Company, "id" | "createdAt" | "updatedAt">>): Promise<Company | undefined> | Company | undefined;
  delete(id: string): Promise<boolean> | boolean;
}

export class SqliteCompanyRepository implements CompanyRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(includeArchived = true): Company[] {
    const where = includeArchived ? "" : " WHERE archived_at IS NULL";
    return (this.database.prepare(`SELECT * FROM companies${where} ORDER BY name COLLATE NOCASE, id`).all() as unknown as CompanyRow[]).map(toCompany);
  }

  findById(id: string): Company | undefined {
    const row = this.database.prepare("SELECT * FROM companies WHERE id = ?").get(id) as CompanyRow | undefined;
    return row ? toCompany(row) : undefined;
  }

  findByName(name: string): Company | undefined {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const row = this.database.prepare("SELECT * FROM companies WHERE name = ? COLLATE NOCASE LIMIT 1").get(trimmed) as CompanyRow | undefined;
    return row ? toCompany(row) : undefined;
  }

  create(input: Omit<Company, "id" | "createdAt" | "updatedAt"> & { id?: string }): Company {
    const trimmedName = input.name.trim();
    if (!input.id) {
      const existing = this.findByName(trimmedName);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    this.database.prepare("INSERT INTO companies (id, name, code, contact, notes, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      trimmedName,
      input.code ?? null,
      input.contact ?? null,
      input.notes ?? null,
      input.archivedAt ?? null,
      now,
      now
    );
    return this.findById(id)!;
  }

  update(id: string, changes: Partial<Omit<Company, "id" | "createdAt" | "updatedAt">>): Company | undefined {
    if (!this.findById(id)) return undefined;
    const fields: Array<[string, SQLOutputValue]> = [];
    if (changes.name !== undefined) fields.push(["name", changes.name.trim()]);
    if (changes.code !== undefined) fields.push(["code", changes.code ?? null]);
    if (changes.contact !== undefined) fields.push(["contact", changes.contact ?? null]);
    if (changes.notes !== undefined) fields.push(["notes", changes.notes ?? null]);
    if (changes.archivedAt !== undefined) fields.push(["archived_at", changes.archivedAt ?? null]);
    fields.push(["updated_at", new Date().toISOString()]);
    this.database.prepare(`UPDATE companies SET ${fields.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`).run(
      ...fields.map(([, value]) => value),
      id
    );
    return this.findById(id);
  }

  delete(id: string): boolean {
    try {
      return (this.database.prepare("DELETE FROM companies WHERE id = ?").run(id) as { changes: number }).changes > 0;
    } catch (error) {
      if (error instanceof Error && /FOREIGN KEY/i.test(error.message)) {
        throw new Error("Company is referenced by tenders or workflow records; archive it instead.");
      }
      throw error;
    }
  }
}

export class PgCompanyRepository implements CompanyRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(includeArchived = true): Promise<Company[]> {
    const query = includeArchived
      ? "SELECT * FROM companies ORDER BY LOWER(name), id"
      : "SELECT * FROM companies WHERE archived_at IS NULL ORDER BY LOWER(name), id";
    const res = await this.pool.query<CompanyRow>(query);
    return res.rows.map(toCompany);
  }

  async findById(id: string): Promise<Company | undefined> {
    const res = await this.pool.query<CompanyRow>("SELECT * FROM companies WHERE id = $1", [id]);
    return res.rows[0] ? toCompany(res.rows[0]) : undefined;
  }

  async findByName(name: string): Promise<Company | undefined> {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const res = await this.pool.query<CompanyRow>(
      "SELECT * FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1",
      [trimmed]
    );
    return res.rows[0] ? toCompany(res.rows[0]) : undefined;
  }

  async create(input: Omit<Company, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Company> {
    const trimmedName = input.name.trim();
    if (!input.id) {
      const existing = await this.findByName(trimmedName);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    await this.pool.query(
      `INSERT INTO companies (id, name, code, contact, notes, archived_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        trimmedName,
        input.code ?? null,
        input.contact ?? null,
        input.notes ?? null,
        input.archivedAt ? new Date(input.archivedAt).toISOString() : null,
        now,
        now,
      ]
    );
    const created = await this.findById(id);
    return created!;
  }

  async update(id: string, changes: Partial<Omit<Company, "id" | "createdAt" | "updatedAt">>): Promise<Company | undefined> {
    const existing = await this.findById(id);
    if (!existing) return undefined;

    const fields: Array<[string, any]> = [];
    if (changes.name !== undefined) fields.push(["name", changes.name.trim()]);
    if (changes.code !== undefined) fields.push(["code", changes.code ?? null]);
    if (changes.contact !== undefined) fields.push(["contact", changes.contact ?? null]);
    if (changes.notes !== undefined) fields.push(["notes", changes.notes ?? null]);
    if (changes.archivedAt !== undefined) fields.push(["archived_at", changes.archivedAt ? new Date(changes.archivedAt).toISOString() : null]);

    const now = new Date().toISOString();
    fields.push(["updated_at", now]);

    const setClauses = fields.map(([field], idx) => `"${field}" = $${idx + 1}`).join(", ");
    await this.pool.query(
      `UPDATE companies SET ${setClauses} WHERE id = $${fields.length + 1}`,
      [...fields.map(([, val]) => val), id]
    );
    return await this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    try {
      const res = await this.pool.query("DELETE FROM companies WHERE id = $1", [id]);
      return Number(res.rowCount ?? 0) > 0;
    } catch (error: any) {
      if (error && (error.code === "23503" || /FOREIGN KEY/i.test(error.message))) {
        throw new Error("Company is referenced by tenders or workflow records; archive it instead.");
      }
      throw error;
    }
  }
}
