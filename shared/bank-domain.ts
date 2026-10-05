import { z } from "zod";

export const emailTemplateTypes = ["purchase-sheet-bank", "company-noa"] as const;
export type EmailTemplateType = (typeof emailTemplateTypes)[number];

export interface BankProfile {
  id: 1;
  accountName: string;
  accountNumberMasked?: string;
  branch: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface EmailTemplate {
  id: string;
  type: EmailTemplateType;
  name: string;
  companyId?: string;
  companyName?: string;
  to: string;
  cc?: string;
  subject: string;
  selected: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const nonEmpty = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
export const bankProfileSchema = z.object({ accountName: nonEmpty, accountNumber: nonEmpty, branch: nonEmpty });
export type BankProfileInput = z.infer<typeof bankProfileSchema>;

const emailTemplateFields = {
  type: z.enum(emailTemplateTypes),
  name: nonEmpty,
  companyId: optionalText,
  to: nonEmpty,
  cc: optionalText,
  subject: nonEmpty,
};
export const createEmailTemplateSchema = z.object(emailTemplateFields).superRefine((value, context) => {
  if (value.type === "company-noa" && !value.companyId) context.addIssue({ code: "custom", path: ["companyId"], message: "Company is required for company/NOA templates" });
});
export const updateEmailTemplateSchema = z.object({ ...emailTemplateFields, selected: z.boolean().optional() }).partial().superRefine((value, context) => {
  if (value.type === "company-noa" && value.companyId === "") context.addIssue({ code: "custom", path: ["companyId"], message: "Company is required for company/NOA templates" });
});
export type CreateEmailTemplateInput = z.infer<typeof createEmailTemplateSchema>;
export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateSchema>;
