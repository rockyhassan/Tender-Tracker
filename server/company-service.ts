import { companySchema, updateCompanySchema, type Company, type CreateCompanyInput, type UpdateCompanyInput } from "../shared/domain";
import type { ZodIssue } from "zod";
import type { CompanyRepository } from "./company-repository";

export class CompanyValidationError extends Error {
  constructor(public readonly issues: ZodIssue[]) {
    super("Company request validation failed");
    this.name = "CompanyValidationError";
  }
}

const parse = <T>(result: { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } }): T => {
  if (!result.success) throw new CompanyValidationError(result.error.issues);
  return result.data;
};

export class CompanyService {
  constructor(private readonly repository: CompanyRepository) {}

  async list(includeArchived = true): Promise<Company[]> {
    return await this.repository.list(includeArchived);
  }

  async get(id: string): Promise<Company | undefined> {
    return await this.repository.findById(id);
  }

  async create(raw: unknown): Promise<Company> {
    const input = parse<CreateCompanyInput>(companySchema.safeParse(raw));
    return await this.repository.create(input);
  }

  async update(id: string, raw: unknown): Promise<Company | undefined> {
    const input = parse<UpdateCompanyInput>(updateCompanySchema.safeParse(raw));
    return await this.repository.update(id, input);
  }

  async archive(id: string, archived: boolean): Promise<Company | undefined> {
    return await this.repository.update(id, {
      archivedAt: (archived ? new Date().toISOString() : null) as unknown as string,
    });
  }

  async delete(id: string): Promise<boolean> {
    return await this.repository.delete(id);
  }
}
