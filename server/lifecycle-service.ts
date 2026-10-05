import { z, type ZodIssue } from "zod";
import {
  chargeSchema,
  contractAgreementSchema,
  creditCommitmentCertificateSchema,
  noaSchema,
  payOrderSchema,
  performanceSecuritySchema,
  tenderResultSchema,
  type ChargeInput,
  type ContractAgreementInput,
  type CreditCommitmentCertificateInput,
  type NOAInput,
  type PayOrderInput,
  type PerformanceSecurityInput,
  type TenderResultInput,
} from "../shared/domain";
import type { LifecycleRepository, PgLifecycleRepository } from "./lifecycle-repository";

export class LifecycleValidationError extends Error {
  constructor(public readonly issues: ZodIssue[]) {
    super("Tender lifecycle request validation failed");
    this.name = "LifecycleValidationError";
  }
}

const parse = <T>(result: { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } }): T => {
  if (!result.success) throw new LifecycleValidationError(result.error.issues);
  return result.data;
};

const normalizeDates = (input: Record<string, any>, keys: string[]) => {
  const result = { ...input };
  if (result.chargeType && !result.type) result.type = result.chargeType;
  if (result.date && !result.chargedAt) result.chargedAt = result.date;
  if (result.number && !result.orderNumber) result.orderNumber = result.number;
  if (result.value !== undefined && result.amount === undefined) result.amount = result.value;
  if (result.issueDate && !result.issuedAt) result.issuedAt = result.issueDate;
  if (result.expiryDate && !result.expiresAt) result.expiresAt = result.expiryDate;
  if (result.agreementDate && !result.signedAt) result.signedAt = result.agreementDate;
  if (result.signUpDate && !result.signedAt) result.signedAt = result.signUpDate;
  for (const key of keys) if (result[key]) result[key] = new Date(result[key]).toISOString();
  return result;
};

export class LifecycleService {
  constructor(private readonly repository: LifecycleRepository | PgLifecycleRepository) {}

  async details(id: string) {
    return await this.repository.details(id);
  }

  async createCharge(id: string, raw: unknown) {
    return await this.repository.createCharge(
      id,
      parse<ChargeInput>(chargeSchema.safeParse(normalizeDates(raw as Record<string, any>, ["chargedAt"])))
    );
  }

  async updateCharge(_tenderId: string, id: string, raw: unknown) {
    return await this.repository.updateCharge(
      id,
      parse<Partial<ChargeInput>>(
        chargeSchema.partial().safeParse(normalizeDates(raw as Record<string, any>, ["chargedAt"]))
      )
    );
  }

  async deleteCharge(_tenderId: string, id: string) {
    return await this.repository.deleteCharge(id);
  }

  async createPayOrder(id: string, raw: unknown) {
    return await this.repository.createPayOrder(
      id,
      parse<PayOrderInput>(
        payOrderSchema.safeParse(
          normalizeDates(raw as Record<string, any>, ["issuedAt", "expiresAt", "returnDueAt", "returnedAt"])
        )
      )
    );
  }

  async updatePayOrder(_tenderId: string, id: string, raw: unknown) {
    return await this.repository.updatePayOrder(
      id,
      parse<Partial<PayOrderInput>>(
        payOrderSchema.partial().safeParse(
          normalizeDates(raw as Record<string, any>, ["issuedAt", "expiresAt", "returnDueAt", "returnedAt"])
        )
      )
    );
  }

  async deletePayOrder(_tenderId: string, id: string) {
    return await this.repository.deletePayOrder(id);
  }

  async createCertificate(id: string, raw: unknown) {
    return await this.repository.createCertificate(
      id,
      parse<CreditCommitmentCertificateInput>(
        creditCommitmentCertificateSchema.safeParse(
          normalizeDates(raw as Record<string, any>, ["issuedAt", "expiresAt", "returnDate"])
        )
      )
    );
  }

  async updateCertificate(_tenderId: string, id: string, raw: unknown) {
    return await this.repository.updateCertificate(
      id,
      parse<Partial<CreditCommitmentCertificateInput>>(
        creditCommitmentCertificateSchema.partial().safeParse(
          normalizeDates(raw as Record<string, any>, ["issuedAt", "expiresAt", "returnDate"])
        )
      )
    );
  }

  async deleteCertificate(_tenderId: string, id: string) {
    return await this.repository.deleteCertificate(id);
  }

  async upsertResult(id: string, raw: unknown) {
    return await this.repository.upsertResult(
      id,
      parse<TenderResultInput>(
        tenderResultSchema.safeParse(
          normalizeDates(raw as Record<string, any>, ["resultDate", "announcedAt"])
        )
      )
    );
  }

  async upsertNoa(id: string, raw: unknown) {
    return await this.repository.upsertNoa(
      id,
      parse<NOAInput>(
        noaSchema.safeParse(
          normalizeDates(raw as Record<string, any>, ["issuedAt", "acceptanceDeadline"])
        )
      )
    );
  }

  async upsertSecurity(id: string, raw: unknown) {
    return await this.repository.upsertSecurity(
      id,
      parse<PerformanceSecurityInput>(
        performanceSecuritySchema.safeParse(
          normalizeDates(raw as Record<string, any>, ["issuedAt", "expiresAt", "returnDate"])
        )
      )
    );
  }

  async upsertContractAgreement(id: string, raw: unknown) {
    return await this.repository.upsertContractAgreement(
      id,
      parse<ContractAgreementInput>(
        contractAgreementSchema.safeParse(
          normalizeDates(raw as Record<string, any>, ["signedAt", "agreementDate", "signUpDate", "startDate", "endDate"])
        )
      )
    );
  }

  async updateContractAgreement(_tenderId: string, id: string, raw: unknown) {
    return await this.repository.updateContractAgreement(
      id,
      parse<Partial<ContractAgreementInput>>(
        contractAgreementSchema.partial().safeParse(
          normalizeDates(raw as Record<string, any>, ["signedAt", "agreementDate", "signUpDate", "startDate", "endDate"])
        )
      )
    );
  }
}
