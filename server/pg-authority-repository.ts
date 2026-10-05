import { randomUUID } from "node:crypto";
import type pg from "pg";
import { authoritySchema, AuthorityValidationError, type AuthorityInput } from "./authority-service";

const toIso = (val: unknown): string | undefined => {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

const map = (row: any) => ({
  id: row.id,
  name: row.name,
  zone: row.zone ?? undefined,
  contact: row.contact ?? undefined,
  referenceNotes: row.reference_notes ?? undefined,
  etenderPortal: row.etender_portal ?? undefined,
  etenderReference: row.etender_reference ?? undefined,
  etenderNotes: row.etender_notes ?? undefined,
  createdAt: toIso(row.created_at)!,
  updatedAt: toIso(row.updated_at)!,
});

export class PgAuthorityRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list() {
    const res = await this.pool.query("SELECT * FROM authorities ORDER BY LOWER(name), id");
    return res.rows.map(map);
  }

  async get(id: string) {
    const res = await this.pool.query("SELECT * FROM authorities WHERE id = $1", [id]);
    return res.rows[0] ? map(res.rows[0]) : undefined;
  }

  async create(input: AuthorityInput) {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO authorities (id, name, zone, contact, reference_notes, etender_portal, etender_reference, etender_notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        input.name,
        input.zone || null,
        input.contact || null,
        input.referenceNotes || null,
        input.etenderPortal || null,
        input.etenderReference || null,
        input.etenderNotes || null,
        now,
        now,
      ]
    );
    return (await this.get(id))!;
  }

  async update(id: string, input: Partial<AuthorityInput>) {
    const current = await this.get(id);
    if (!current) return undefined;
    const value = { ...current, ...input };
    const parsed = authoritySchema.safeParse(value);
    if (!parsed.success) throw new AuthorityValidationError("Invalid authority profile", parsed.error.issues);
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE authorities SET name = $1, zone = $2, contact = $3, reference_notes = $4, etender_portal = $5, etender_reference = $6, etender_notes = $7, updated_at = $8 WHERE id = $9`,
      [
        parsed.data.name,
        parsed.data.zone || null,
        parsed.data.contact || null,
        parsed.data.referenceNotes || null,
        parsed.data.etenderPortal || null,
        parsed.data.etenderReference || null,
        parsed.data.etenderNotes || null,
        now,
        id,
      ]
    );
    return await this.get(id);
  }

  async delete(id: string) {
    const res = await this.pool.query("DELETE FROM authorities WHERE id = $1", [id]);
    return Number(res.rowCount ?? 0) > 0;
  }
}
