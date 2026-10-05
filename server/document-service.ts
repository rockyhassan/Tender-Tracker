import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import type { DocumentMetadata } from "../shared/domain";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".zip",
  ".docx",
  ".xlsx",
  ".pptx",
]);

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}

export interface DocumentInput {
  fileName: string;
  mimeType?: string;
  data: string;
  tenderId?: string;
  authorityId?: string;
}

export interface StoredDocumentMetadata extends DocumentMetadata {
  storageName: string;
}

export interface DocumentStorage {
  upload(storageName: string, bytes: Buffer, mimeType: string): Promise<void>;
  download(storageName: string): Promise<Buffer | null>;
  delete(storageName: string): Promise<void>;
}

export interface IDocumentRepository {
  list(target: { tenderId?: string; authorityId?: string }): Promise<DocumentMetadata[]>;
  get(id: string): Promise<StoredDocumentMetadata | undefined>;
  insert(doc: {
    id: string;
    tenderId?: string | null;
    authorityId?: string | null;
    fileName: string;
    storageName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
  }): Promise<void>;
  delete(id: string): Promise<boolean>;
  targetExists(target: { tenderId?: string; authorityId?: string }): Promise<boolean>;
}

/**
 * Supabase Storage adapter for document binary files.
 * Uses a private Supabase Storage bucket (default: "documents").
 */
export class SupabaseDocumentStorage implements DocumentStorage {
  constructor(
    private readonly client: SupabaseClient,
    private readonly bucketName: string = "documents"
  ) {}

  async upload(storageName: string, bytes: Buffer, mimeType: string): Promise<void> {
    const { error } = await this.client.storage
      .from(this.bucketName)
      .upload(storageName, bytes, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      throw new Error(`Supabase Storage upload failed: ${error.message}`);
    }
  }

  async download(storageName: string): Promise<Buffer | null> {
    const { data, error } = await this.client.storage
      .from(this.bucketName)
      .download(storageName);

    if (error || !data) {
      return null;
    }

    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(storageName: string): Promise<void> {
    const { error } = await this.client.storage
      .from(this.bucketName)
      .remove([storageName]);

    if (error) {
      throw new Error(`Supabase Storage delete failed: ${error.message}`);
    }
  }
}

/**
 * Local filesystem adapter for document binary files (local/offline fallback).
 */
export class LocalFileDocumentStorage implements DocumentStorage {
  readonly directory: string;

  constructor(directory = process.env.TENDER_DOCUMENTS_DIR ?? resolve(process.cwd(), "data/documents")) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true });
  }

  async upload(storageName: string, bytes: Buffer): Promise<void> {
    const storagePath = join(this.directory, storageName);
    writeFileSync(storagePath, bytes, { flag: "wx", mode: 0o600 });
  }

  async download(storageName: string): Promise<Buffer | null> {
    const storagePath = join(this.directory, storageName);
    if (!existsSync(storagePath)) return null;
    try {
      return readFileSync(storagePath);
    } catch {
      return null;
    }
  }

  async delete(storageName: string): Promise<void> {
    const storagePath = join(this.directory, storageName);
    rmSync(storagePath, { force: true });
  }
}

const toIso = (val: unknown): string => {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

const mapPgRow = (row: any): DocumentMetadata => ({
  id: row.id,
  tenderId: row.tender_id ?? undefined,
  authorityId: row.authority_id ?? undefined,
  fileName: row.file_name,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
  createdAt: toIso(row.created_at),
});

/**
 * PostgreSQL repository for document metadata records.
 */
export class PgDocumentRepository implements IDocumentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async targetExists(target: { tenderId?: string; authorityId?: string }): Promise<boolean> {
    if (target.tenderId) {
      const res = await this.pool.query("SELECT 1 FROM tenders WHERE id = $1", [target.tenderId]);
      return res.rows.length > 0;
    }
    if (target.authorityId) {
      const res = await this.pool.query("SELECT 1 FROM authorities WHERE id = $1", [target.authorityId]);
      return res.rows.length > 0;
    }
    return false;
  }

  async list(target: { tenderId?: string; authorityId?: string }): Promise<DocumentMetadata[]> {
    const field = target.tenderId ? "tender_id" : "authority_id";
    const id = (target.tenderId ?? target.authorityId)!;
    const res = await this.pool.query(
      `SELECT * FROM documents WHERE ${field} = $1 ORDER BY created_at DESC, id`,
      [id]
    );
    return res.rows.map(mapPgRow);
  }

  async get(id: string): Promise<StoredDocumentMetadata | undefined> {
    const res = await this.pool.query("SELECT * FROM documents WHERE id = $1", [id]);
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      ...mapPgRow(row),
      storageName: row.storage_name,
    };
  }

  async insert(doc: {
    id: string;
    tenderId?: string | null;
    authorityId?: string | null;
    fileName: string;
    storageName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO documents (id, tender_id, authority_id, file_name, storage_name, mime_type, size_bytes, sha256, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        doc.id,
        doc.tenderId ?? null,
        doc.authorityId ?? null,
        doc.fileName,
        doc.storageName,
        doc.mimeType,
        doc.sizeBytes,
        doc.sha256,
        doc.createdAt,
      ]
    );
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM documents WHERE id = $1", [id]);
    return Number(res.rowCount ?? 0) > 0;
  }
}

const mapSqliteRow = (row: any): DocumentMetadata => ({
  id: row.id,
  tenderId: row.tender_id ?? undefined,
  authorityId: row.authority_id ?? undefined,
  fileName: row.file_name,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
  createdAt: row.created_at,
});

/**
 * SQLite repository for document metadata records (local/offline fallback).
 */
export class SqliteDocumentRepository implements IDocumentRepository {
  constructor(private readonly db: DatabaseSync) {}

  async targetExists(target: { tenderId?: string; authorityId?: string }): Promise<boolean> {
    if (target.tenderId) {
      return Boolean(this.db.prepare("SELECT 1 FROM tenders WHERE id=?").get(target.tenderId));
    }
    if (target.authorityId) {
      return Boolean(this.db.prepare("SELECT 1 FROM authorities WHERE id=?").get(target.authorityId));
    }
    return false;
  }

  async list(target: { tenderId?: string; authorityId?: string }): Promise<DocumentMetadata[]> {
    const field = target.tenderId ? "tender_id" : "authority_id";
    const id = (target.tenderId ?? target.authorityId)!;
    const rows = this.db.prepare(`SELECT * FROM documents WHERE ${field}=? ORDER BY created_at DESC, id`).all(id) as any[];
    return rows.map(mapSqliteRow);
  }

  async get(id: string): Promise<StoredDocumentMetadata | undefined> {
    const row = this.db.prepare("SELECT * FROM documents WHERE id=?").get(id) as any;
    if (!row) return undefined;
    return {
      ...mapSqliteRow(row),
      storageName: row.storage_name,
    };
  }

  async insert(doc: {
    id: string;
    tenderId?: string | null;
    authorityId?: string | null;
    fileName: string;
    storageName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
  }): Promise<void> {
    this.db.prepare(
      "INSERT INTO documents (id, tender_id, authority_id, file_name, storage_name, mime_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      doc.id,
      doc.tenderId ?? null,
      doc.authorityId ?? null,
      doc.fileName,
      doc.storageName,
      doc.mimeType,
      doc.sizeBytes,
      doc.sha256,
      doc.createdAt
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM documents WHERE id=?").run(id);
    return Number(result.changes) > 0;
  }
}

/**
 * Service managing document attachments: validates, uploads to Supabase Storage,
 * persists metadata to PostgreSQL, downloads server-side, and cleans up storage/metadata safely.
 */
export class DocumentService {
  readonly repo: IDocumentRepository;
  readonly storage: DocumentStorage;

  constructor(
    repoOrDb: IDocumentRepository | DatabaseSync,
    storageOrDir?: DocumentStorage | string
  ) {
    if (repoOrDb && typeof repoOrDb === "object" && "list" in repoOrDb && typeof repoOrDb.list === "function") {
      this.repo = repoOrDb as IDocumentRepository;
    } else {
      this.repo = new SqliteDocumentRepository(repoOrDb as DatabaseSync);
    }

    if (storageOrDir && typeof storageOrDir === "object" && "upload" in storageOrDir) {
      this.storage = storageOrDir as DocumentStorage;
    } else {
      this.storage = new LocalFileDocumentStorage(typeof storageOrDir === "string" ? storageOrDir : undefined);
    }
  }

  get directory(): string | undefined {
    return (this.storage as any).directory;
  }

  private async assertTarget(input: DocumentInput): Promise<void> {
    if ((input.tenderId ? 1 : 0) + (input.authorityId ? 1 : 0) !== 1) {
      throw new DocumentValidationError("Exactly one tenderId or authorityId is required");
    }
    const exists = await this.repo.targetExists(input);
    if (!exists) {
      if (input.tenderId) throw new DocumentValidationError("Tender not found");
      if (input.authorityId) throw new DocumentValidationError("Authority not found");
    }
  }

  async list(target: { tenderId?: string; authorityId?: string }): Promise<DocumentMetadata[]> {
    if ((target.tenderId ? 1 : 0) + (target.authorityId ? 1 : 0) !== 1) {
      throw new DocumentValidationError("Exactly one tenderId or authorityId is required");
    }
    return await this.repo.list(target);
  }

  async create(input: DocumentInput): Promise<DocumentMetadata> {
    await this.assertTarget(input);
    const name = basename(String(input.fileName || "")).trim();
    const ext = extname(name).toLowerCase();
    if (!name || name.length > 255 || name !== input.fileName || /[\u0000-\u001f]/.test(name)) {
      throw new DocumentValidationError("Invalid file name");
    }
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new DocumentValidationError("Unsupported document type");
    }
    const mime = (input.mimeType || "application/octet-stream").toLowerCase();
    if (!ALLOWED_TYPES.has(mime)) {
      throw new DocumentValidationError("Unsupported document type");
    }
    if (typeof input.data !== "string" || !/^data:[^;]+;base64,/.test(input.data)) {
      throw new DocumentValidationError("Document data must be a base64 data URL");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.data.slice(input.data.indexOf(",") + 1), "base64");
    } catch {
      throw new DocumentValidationError("Invalid document data");
    }
    if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) {
      throw new DocumentValidationError(`Document exceeds ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit`);
    }

    const id = randomUUID();
    const storageName = `${id}${ext}`;
    const now = new Date().toISOString();
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // 1. Upload binary to storage first
    await this.storage.upload(storageName, bytes, mime);

    // 2. Insert metadata into database
    try {
      await this.repo.insert({
        id,
        tenderId: input.tenderId ?? null,
        authorityId: input.authorityId ?? null,
        fileName: name,
        storageName,
        mimeType: mime,
        sizeBytes: bytes.length,
        sha256,
        createdAt: now,
      });
    } catch (error) {
      // Clean up uploaded storage object if metadata insert fails
      await this.storage.delete(storageName).catch(() => {});
      throw error;
    }

    const created = await this.repo.get(id);
    if (!created) {
      throw new Error("Failed to retrieve created document metadata");
    }
    return created;
  }

  async get(id: string): Promise<StoredDocumentMetadata | undefined> {
    return await this.repo.get(id);
  }

  async read(id: string): Promise<{ item: DocumentMetadata; bytes: Buffer } | undefined> {
    const item = await this.get(id);
    if (!item) return undefined;

    const bytes = await this.storage.download(item.storageName);
    if (!bytes) {
      // Storage object not found - returns undefined safely without crashing server
      return undefined;
    }
    return { item, bytes };
  }

  async delete(id: string): Promise<boolean> {
    const item = await this.get(id);
    if (!item) return false;

    // Remove from storage first
    try {
      await this.storage.delete(item.storageName);
    } catch (error) {
      // Log warning but continue to delete metadata so database doesn't claim file exists
      console.warn(`[DocumentService] Notice: Storage object removal issue for ${item.storageName}:`, error);
    }

    // Then delete metadata from database
    return await this.repo.delete(id);
  }
}
