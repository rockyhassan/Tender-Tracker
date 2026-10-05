import type { DatabaseSync } from "node:sqlite";
import type pg from "pg";
import type { ZodIssue } from "zod";
import {
  bankProfileSchema,
  createEmailTemplateSchema,
  updateEmailTemplateSchema,
  type BankProfile,
  type BankProfileInput,
  type CreateEmailTemplateInput,
  type EmailTemplate,
  type UpdateEmailTemplateInput,
} from "../shared/bank-domain";
import { decryptSecret, encryptSecret, type SecurityService } from "./security-service";
import { maskAccountNumber, type BankRepository } from "./bank-repository";

export class BankValidationError extends Error {
  constructor(public readonly issues: ZodIssue[]) {
    super("Bank profile or email template validation failed");
    this.name = "BankValidationError";
  }
}

const parseOrThrow = <T>(result: { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } }): T => {
  if (!result.success) throw new BankValidationError(result.error.issues);
  return result.data;
};

export class BankService {
  constructor(
    private readonly repository: BankRepository,
    private readonly security: SecurityService,
    private readonly database?: DatabaseSync | pg.Pool
  ) {}

  async getProfile(token: string | undefined): Promise<BankProfile | undefined> {
    const session = this.security.requireSession(token);
    const profile = await this.repository.getProfile();
    if (!profile) return undefined;
    const ciphertext = await this.repository.getProfileCiphertext();
    if (!ciphertext) return profile;
    return { ...profile, accountNumberMasked: maskAccountNumber(decryptSecret(ciphertext, session.key)) };
  }

  async saveProfile(token: string | undefined, rawInput: unknown): Promise<BankProfile> {
    const session = this.security.requireSession(token);
    const input = parseOrThrow<BankProfileInput>(bankProfileSchema.safeParse(rawInput));
    const profile = await this.repository.saveProfile({
      ...input,
      accountNumberCiphertext: encryptSecret(input.accountNumber, session.key),
    });
    return { ...profile, accountNumberMasked: maskAccountNumber(input.accountNumber) };
  }

  async listTemplates(): Promise<EmailTemplate[]> {
    return await this.repository.listTemplates();
  }

  async createTemplate(rawInput: unknown): Promise<EmailTemplate> {
    const input = parseOrThrow<CreateEmailTemplateInput>(createEmailTemplateSchema.safeParse(rawInput));
    await this.assertCompany(input.companyId);
    return await this.repository.createTemplate(input);
  }

  async updateTemplate(id: string, rawInput: unknown): Promise<EmailTemplate | undefined> {
    const input = parseOrThrow<UpdateEmailTemplateInput>(updateEmailTemplateSchema.safeParse(rawInput));
    const existing = await this.repository.findTemplate(id);
    if (!existing) return undefined;
    const type = input.type ?? existing.type;
    const companyId = input.companyId !== undefined ? input.companyId : existing.companyId;
    if (type === "company-noa" && !companyId) {
      throw new BankValidationError([{ code: "custom", path: ["companyId"], message: "Company is required for company/NOA templates" }]);
    }
    await this.assertCompany(companyId);
    return await this.repository.updateTemplate(id, input);
  }

  async selectTemplate(id: string): Promise<EmailTemplate | undefined> {
    return await this.repository.selectTemplate(id);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    return await this.repository.deleteTemplate(id);
  }

  private async assertCompany(companyId?: string): Promise<void> {
    if (!companyId || !this.database) return;
    if ("prepare" in this.database) {
      if (!this.database.prepare("SELECT id FROM companies WHERE id = ?").get(companyId)) {
        throw new BankValidationError([{ code: "custom", path: ["companyId"], message: "Company was not found" }]);
      }
    } else if ("query" in this.database) {
      const res = await (this.database as pg.Pool).query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (res.rows.length === 0) {
        throw new BankValidationError([{ code: "custom", path: ["companyId"], message: "Company was not found" }]);
      }
    }
  }
}
