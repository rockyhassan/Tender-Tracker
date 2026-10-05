import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type pg from "pg";

const HASH_VERSION = "scrypt-v1";
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;
const SESSION_TTL_MS = 30 * 60 * 1000;

export class SecurityError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "SecurityError";
  }
}

export function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new SecurityError(`Master password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

export function hashPassword(password: string): string {
  assertPassword(password);
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 });
  return `${HASH_VERSION}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

function parseHash(encoded: string): { salt: Buffer; digest: Buffer } {
  const [version, saltEncoded, digestEncoded] = encoded.split("$");
  if (version !== HASH_VERSION || !saltEncoded || !digestEncoded) {
    throw new SecurityError("Stored master password hash is invalid.", 500);
  }
  return { salt: Buffer.from(saltEncoded, "base64url"), digest: Buffer.from(digestEncoded, "base64url") };
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const { salt, digest } = parseHash(encoded);
    const candidate = scryptSync(password, salt, digest.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 });
    return candidate.length === digest.length && timingSafeEqual(candidate, digest);
  } catch {
    return false;
  }
}

function keyForPassword(password: string, encodedHash: string): Buffer {
  const { salt } = parseHash(encodedHash);
  return scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 });
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes-256-gcm-v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = encoded.split(":");
  if (version !== "aes-256-gcm-v1" || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new SecurityError("Stored credential ciphertext is invalid.", 500);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]).toString("utf8");
}

interface Session {
  key: Buffer;
  expiresAt: number;
}
export interface SecurityStatus {
  configured: boolean;
  unlocked: boolean;
  recoveryEmail?: string;
  recoveryResetRequestedAt?: string;
  recoveryResetRequestId?: string;
  sessionExpiresAt?: string;
}
export interface CompanySecuritySummary {
  id: string;
  name: string;
  code?: string;
  contact?: string;
  notes?: string;
  archivedAt?: string;
  hasCredentials: boolean;
  usernameMasked?: string;
  updatedAt?: string;
}

const toIso = (val: unknown): string | undefined => {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

export class SecurityService {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly database: DatabaseSync | pg.Pool) {}

  private isPg(): boolean {
    return Boolean(this.database && "query" in this.database);
  }

  private async settings(): Promise<
    | {
        password_hash: string;
        recovery_email: string | null;
        recovery_reset_requested_at: string | Date | null;
        recovery_reset_request_id: string | null;
      }
    | undefined
  > {
    if (this.isPg()) {
      const res = await (this.database as pg.Pool).query(
        "SELECT password_hash, recovery_email, recovery_reset_requested_at, recovery_reset_request_id FROM app_security WHERE id = 1"
      );
      return res.rows[0];
    }
    return (this.database as DatabaseSync)
      .prepare(
        "SELECT password_hash, recovery_email, recovery_reset_requested_at, recovery_reset_request_id FROM app_security WHERE id = 1"
      )
      .get() as any;
  }

  async status(token?: string): Promise<SecurityStatus> {
    const settings = await this.settings();
    const session = token ? this.getSession(token, false) : undefined;
    return {
      configured: Boolean(settings),
      unlocked: Boolean(session),
      recoveryEmail: settings?.recovery_email ?? undefined,
      recoveryResetRequestedAt: toIso(settings?.recovery_reset_requested_at),
      recoveryResetRequestId: settings?.recovery_reset_request_id ?? undefined,
      sessionExpiresAt: session ? new Date(session.expiresAt).toISOString() : undefined,
    };
  }

  async setup(password: unknown, recoveryEmail?: unknown): Promise<{ token: string; status: SecurityStatus }> {
    assertPassword(password);
    if (await this.settings()) throw new SecurityError("Master password is already configured. Unlock to change it.", 409);
    const hash = hashPassword(password);
    const now = new Date().toISOString();

    if (this.isPg()) {
      await (this.database as pg.Pool).query(
        "INSERT INTO app_security (id, password_hash, recovery_email, created_at, updated_at) VALUES (1, $1, $2, $3, $4)",
        [hash, this.email(recoveryEmail), now, now]
      );
    } else {
      (this.database as DatabaseSync)
        .prepare("INSERT INTO app_security (id, password_hash, recovery_email, created_at, updated_at) VALUES (1, ?, ?, ?, ?)")
        .run(hash, this.email(recoveryEmail), now, now);
    }

    const token = this.createSession(keyForPassword(password, hash));
    return { token, status: await this.status(token) };
  }

  async unlock(password: unknown): Promise<{ token: string; status: SecurityStatus }> {
    if (typeof password !== "string") throw new SecurityError("Master password is required.");
    const settings = await this.settings();
    if (!settings) throw new SecurityError("Set up a master password before unlocking.", 409);
    if (!verifyPassword(password, settings.password_hash)) throw new SecurityError("Incorrect master password.", 401);
    const token = this.createSession(keyForPassword(password, settings.password_hash));
    return { token, status: await this.status(token) };
  }

  lock(token?: string): void {
    if (token) this.sessions.delete(token);
  }

  requireSession(token: string | undefined): Session {
    const session = this.getSession(token, true);
    if (!session) throw new SecurityError("Unlock the app to access protected credentials.", 401);
    return session;
  }

  async changePassword(token: string | undefined, currentPassword: unknown, nextPassword: unknown): Promise<{ status: SecurityStatus }> {
    if (typeof currentPassword !== "string") throw new SecurityError("Current master password is required.");
    assertPassword(nextPassword);
    const session = this.requireSession(token);
    const settings = await this.settings();
    if (!settings || !verifyPassword(currentPassword, settings.password_hash)) {
      throw new SecurityError("Current master password is incorrect.", 401);
    }
    const nextHash = hashPassword(nextPassword);
    const nextKey = keyForPassword(nextPassword, nextHash);
    const now = new Date().toISOString();

    if (this.isPg()) {
      const client = await (this.database as pg.Pool).connect();
      try {
        await client.query("BEGIN");
        const companiesRes = await client.query(
          "SELECT id, tender_username_ciphertext, tender_password_ciphertext FROM companies"
        );
        const bankProfileRes = await client.query(
          "SELECT id, account_number_ciphertext FROM bank_profiles WHERE id = 1"
        );

        for (const company of companiesRes.rows) {
          const username = company.tender_username_ciphertext
            ? decryptSecret(company.tender_username_ciphertext, session.key)
            : undefined;
          const password = company.tender_password_ciphertext
            ? decryptSecret(company.tender_password_ciphertext, session.key)
            : undefined;
          await client.query(
            "UPDATE companies SET tender_username_ciphertext = $1, tender_password_ciphertext = $2, updated_at = $3 WHERE id = $4",
            [username ? encryptSecret(username, nextKey) : null, password ? encryptSecret(password, nextKey) : null, now, company.id]
          );
        }

        if (bankProfileRes.rows[0]) {
          const accountNumber = decryptSecret(bankProfileRes.rows[0].account_number_ciphertext, session.key);
          await client.query(
            "UPDATE bank_profiles SET account_number_ciphertext = $1, updated_at = $2 WHERE id = 1",
            [encryptSecret(accountNumber, nextKey), now]
          );
        }

        await client.query("UPDATE app_security SET password_hash = $1, updated_at = $2 WHERE id = 1", [nextHash, now]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else {
      const db = this.database as DatabaseSync;
      const companies = db.prepare("SELECT id, tender_username_ciphertext, tender_password_ciphertext FROM companies").all() as Array<{
        id: string;
        tender_username_ciphertext: string | null;
        tender_password_ciphertext: string | null;
      }>;
      const bankProfile = db.prepare("SELECT id, account_number_ciphertext FROM bank_profiles WHERE id = 1").get() as
        | { id: number; account_number_ciphertext: string }
        | undefined;
      db.exec("BEGIN");
      try {
        for (const company of companies) {
          const username = company.tender_username_ciphertext
            ? decryptSecret(company.tender_username_ciphertext, session.key)
            : undefined;
          const password = company.tender_password_ciphertext
            ? decryptSecret(company.tender_password_ciphertext, session.key)
            : undefined;
          db.prepare("UPDATE companies SET tender_username_ciphertext = ?, tender_password_ciphertext = ?, updated_at = ? WHERE id = ?").run(
            username ? encryptSecret(username, nextKey) : null,
            password ? encryptSecret(password, nextKey) : null,
            now,
            company.id
          );
        }
        if (bankProfile) {
          const accountNumber = decryptSecret(bankProfile.account_number_ciphertext, session.key);
          db.prepare("UPDATE bank_profiles SET account_number_ciphertext = ?, updated_at = ? WHERE id = 1").run(
            encryptSecret(accountNumber, nextKey),
            now
          );
        }
        db.prepare("UPDATE app_security SET password_hash = ?, updated_at = ? WHERE id = 1").run(nextHash, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    session.key = nextKey;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { status: await this.status(token) };
  }

  async configureRecovery(token: string | undefined, recoveryEmail: unknown): Promise<SecurityStatus> {
    this.requireSession(token);
    const email = this.email(recoveryEmail);
    const now = new Date().toISOString();
    if (this.isPg()) {
      await (this.database as pg.Pool).query("UPDATE app_security SET recovery_email = $1, updated_at = $2 WHERE id = 1", [email, now]);
    } else {
      (this.database as DatabaseSync).prepare("UPDATE app_security SET recovery_email = ?, updated_at = ? WHERE id = 1").run(email, now);
    }
    return await this.status(token);
  }

  async requestRecovery(
    recoveryEmail: unknown
  ): Promise<{ requested: boolean; configured: boolean; requestedAt?: string; requestId?: string; emailConfigured: boolean }> {
    const settings = await this.settings();
    if (!settings) return { requested: false, configured: false, emailConfigured: false };
    const email = this.email(recoveryEmail);
    const matches = Boolean(email && settings.recovery_email && email.toLowerCase() === settings.recovery_email.toLowerCase());
    const requestedAt = new Date().toISOString();
    const requestId = randomBytes(12).toString("hex");

    if (matches) {
      if (this.isPg()) {
        await (this.database as pg.Pool).query(
          "UPDATE app_security SET recovery_reset_requested_at = $1, recovery_reset_request_id = $2, updated_at = $3 WHERE id = 1",
          [requestedAt, requestId, requestedAt]
        );
      } else {
        (this.database as DatabaseSync)
          .prepare("UPDATE app_security SET recovery_reset_requested_at = ?, recovery_reset_request_id = ?, updated_at = ? WHERE id = 1")
          .run(requestedAt, requestId, requestedAt);
      }
    }
    return {
      requested: matches,
      configured: true,
      requestedAt: matches ? requestedAt : undefined,
      requestId: matches ? requestId : undefined,
      emailConfigured: Boolean(settings.recovery_email),
    };
  }

  async listCompanies(): Promise<CompanySecuritySummary[]> {
    let rows: any[];
    if (this.isPg()) {
      const res = await (this.database as pg.Pool).query(
        "SELECT id, name, code, contact, notes, archived_at, tender_username, tender_username_ciphertext, tender_password_ciphertext, updated_at FROM companies ORDER BY LOWER(name), id"
      );
      rows = res.rows;
    } else {
      rows = (this.database as DatabaseSync)
        .prepare(
          "SELECT id, name, code, contact, notes, archived_at, tender_username, tender_username_ciphertext, tender_password_ciphertext, updated_at FROM companies ORDER BY name COLLATE NOCASE, id"
        )
        .all() as any[];
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code ?? undefined,
      contact: row.contact ?? undefined,
      notes: row.notes ?? undefined,
      archivedAt: toIso(row.archived_at),
      hasCredentials: Boolean(row.tender_username_ciphertext || row.tender_password_ciphertext || row.tender_username),
      usernameMasked: row.tender_username_ciphertext ? "••••••••" : undefined,
      updatedAt: toIso(row.updated_at),
    }));
  }

  async getCredentials(
    token: string | undefined,
    companyId: string
  ): Promise<{ companyId: string; companyName: string; username: string; password: string } | undefined> {
    const session = this.requireSession(token);
    let row: any;
    if (this.isPg()) {
      const res = await (this.database as pg.Pool).query(
        "SELECT id, name, tender_username_ciphertext, tender_password_ciphertext FROM companies WHERE id = $1",
        [companyId]
      );
      row = res.rows[0];
    } else {
      row = (this.database as DatabaseSync)
        .prepare("SELECT id, name, tender_username_ciphertext, tender_password_ciphertext FROM companies WHERE id = ?")
        .get(companyId) as any;
    }
    if (!row) return undefined;
    return {
      companyId: row.id,
      companyName: row.name,
      username: row.tender_username_ciphertext ? decryptSecret(row.tender_username_ciphertext, session.key) : "",
      password: row.tender_password_ciphertext ? decryptSecret(row.tender_password_ciphertext, session.key) : "",
    };
  }

  async saveCredentials(
    token: string | undefined,
    companyId: string,
    username: unknown,
    password: unknown
  ): Promise<CompanySecuritySummary | undefined> {
    const session = this.requireSession(token);
    if (typeof username !== "string" || typeof password !== "string") {
      throw new SecurityError("Username and password must be text.");
    }
    const now = new Date().toISOString();

    if (this.isPg()) {
      const check = await (this.database as pg.Pool).query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (check.rows.length === 0) return undefined;
      await (this.database as pg.Pool).query(
        "UPDATE companies SET tender_username = NULL, tender_username_ciphertext = $1, tender_password_ciphertext = $2, updated_at = $3 WHERE id = $4",
        [username ? encryptSecret(username, session.key) : null, password ? encryptSecret(password, session.key) : null, now, companyId]
      );
    } else {
      const db = this.database as DatabaseSync;
      const row = db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId);
      if (!row) return undefined;
      db.prepare(
        "UPDATE companies SET tender_username = NULL, tender_username_ciphertext = ?, tender_password_ciphertext = ?, updated_at = ? WHERE id = ?"
      ).run(username ? encryptSecret(username, session.key) : null, password ? encryptSecret(password, session.key) : null, now, companyId);
    }

    const companies = await this.listCompanies();
    return companies.find((company) => company.id === companyId);
  }

  async clearCredentials(token: string | undefined, companyId: string): Promise<boolean> {
    this.requireSession(token);
    const now = new Date().toISOString();
    if (this.isPg()) {
      const res = await (this.database as pg.Pool).query(
        "UPDATE companies SET tender_username = NULL, tender_username_ciphertext = NULL, tender_password_ciphertext = NULL, updated_at = $1 WHERE id = $2",
        [now, companyId]
      );
      return Number(res.rowCount ?? 0) > 0;
    }
    const result = (this.database as DatabaseSync)
      .prepare(
        "UPDATE companies SET tender_username = NULL, tender_username_ciphertext = NULL, tender_password_ciphertext = NULL, updated_at = ? WHERE id = ?"
      )
      .run(now, companyId);
    return result.changes > 0;
  }

  private email(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      throw new SecurityError("Enter a valid recovery email or leave it blank.");
    }
    return value.trim().toLowerCase();
  }

  private createSession(key: Buffer): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { key, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  createSessionForTesting(ttlMs: number = SESSION_TTL_MS): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { key: randomBytes(32), expiresAt: Date.now() + ttlMs });
    return token;
  }

  private getSession(token: string | undefined, refresh: boolean): Session | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    if (refresh) session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }
}

export function sessionTokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers["x-session-token"];
  return Array.isArray(value) ? value[0] : value;
}

export type SecurityRow = Record<string, SQLOutputValue>;
