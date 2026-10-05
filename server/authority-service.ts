import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const authoritySchema = z.object({
  name: z.string().trim().min(1).max(200),
  zone: z.string().trim().max(120).optional(),
  contact: z.string().trim().max(1000).optional(),
  referenceNotes: z.string().trim().max(5000).optional(),
  etenderPortal: z.string().trim().url().max(500).optional().or(z.literal("")),
  etenderReference: z.string().trim().max(500).optional(),
  etenderNotes: z.string().trim().max(2000).optional(),
});
export const authorityUpdateSchema = authoritySchema.partial();
export type AuthorityInput = z.infer<typeof authoritySchema>;

export class AuthorityValidationError extends Error {
  constructor(message: string, public readonly issues: unknown[] = []) {
    super(message);
    this.name = "AuthorityValidationError";
  }
}

export type AuthorityModel = {
  id: string;
  name: string;
  zone?: string;
  contact?: string;
  referenceNotes?: string;
  etenderPortal?: string;
  etenderReference?: string;
  etenderNotes?: string;
  createdAt: string;
  updatedAt: string;
};

const map = (row: any): AuthorityModel => ({
  id: row.id,
  name: row.name,
  zone: row.zone ?? undefined,
  contact: row.contact ?? undefined,
  referenceNotes: row.reference_notes ?? undefined,
  etenderPortal: row.etender_portal ?? undefined,
  etenderReference: row.etender_reference ?? undefined,
  etenderNotes: row.etender_notes ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface IAuthorityRepository {
  list(): Promise<AuthorityModel[]> | AuthorityModel[];
  get(id: string): Promise<AuthorityModel | undefined> | AuthorityModel | undefined;
  create(input: AuthorityInput): Promise<AuthorityModel> | AuthorityModel;
  update(id: string, input: Partial<AuthorityInput>): Promise<AuthorityModel | undefined> | AuthorityModel | undefined;
  delete(id: string): Promise<boolean> | boolean;
}

export class SqliteAuthorityRepository implements IAuthorityRepository {
  constructor(private readonly db: DatabaseSync) {}
  list() {
    return (this.db.prepare("SELECT * FROM authorities ORDER BY name COLLATE NOCASE, id").all() as any[]).map(map);
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM authorities WHERE id = ?").get(id);
    return row ? map(row) : undefined;
  }
  create(input: AuthorityInput) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO authorities (id,name,zone,contact,reference_notes,etender_portal,etender_reference,etender_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        id,
        input.name,
        input.zone || null,
        input.contact || null,
        input.referenceNotes || null,
        input.etenderPortal || null,
        input.etenderReference || null,
        input.etenderNotes || null,
        now,
        now
      );
    return this.get(id)!;
  }
  update(id: string, input: Partial<AuthorityInput>) {
    if (!this.get(id)) return undefined;
    const current = this.get(id)!;
    const value = { ...current, ...input };
    const parsed = authoritySchema.safeParse(value);
    if (!parsed.success) throw new AuthorityValidationError("Invalid authority profile", parsed.error.issues);
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE authorities SET name=?,zone=?,contact=?,reference_notes=?,etender_portal=?,etender_reference=?,etender_notes=?,updated_at=? WHERE id=?"
      )
      .run(
        parsed.data.name,
        parsed.data.zone || null,
        parsed.data.contact || null,
        parsed.data.referenceNotes || null,
        parsed.data.etenderPortal || null,
        parsed.data.etenderReference || null,
        parsed.data.etenderNotes || null,
        now,
        id
      );
    return this.get(id);
  }
  delete(id: string) {
    return this.db.prepare("DELETE FROM authorities WHERE id = ?").run(id).changes > 0;
  }
}

export const AuthorityRepository = SqliteAuthorityRepository;
export { PgAuthorityRepository } from "./pg-authority-repository";

export class AuthorityService {
  constructor(private readonly repository: IAuthorityRepository) {}
  async list() {
    return await this.repository.list();
  }
  async get(id: string) {
    return await this.repository.get(id);
  }
  async create(raw: unknown) {
    const parsed = authoritySchema.safeParse(raw);
    if (!parsed.success) throw new AuthorityValidationError("Invalid authority profile", parsed.error.issues);
    return await this.repository.create(parsed.data);
  }
  async update(id: string, raw: unknown) {
    const parsed = authorityUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new AuthorityValidationError("Invalid authority profile", parsed.error.issues);
    return await this.repository.update(id, parsed.data);
  }
  async delete(id: string) {
    return await this.repository.delete(id);
  }
}
