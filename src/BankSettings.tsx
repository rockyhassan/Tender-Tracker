import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { BankProfile, CompanySecuritySummary, EmailTemplate, EmailTemplateType } from "../shared/domain";
import { ApiError, createEmailTemplate, deleteEmailTemplate, getBankProfile, listCompanySecurity, listEmailTemplates, saveBankProfile, selectEmailTemplate, updateEmailTemplate } from "./api";

interface TemplateForm { type: EmailTemplateType; name: string; companyId: string; to: string; cc: string; subject: string; }
const blankTemplate = (companies: CompanySecuritySummary[]): TemplateForm => ({ type: "purchase-sheet-bank", name: "", companyId: companies[0]?.id ?? "", to: "", cc: "", subject: "" });
const templateToForm = (template: EmailTemplate): TemplateForm => ({ type: template.type, name: template.name, companyId: template.companyId ?? "", to: template.to, cc: template.cc ?? "", subject: template.subject });
const errorMessage = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Something went wrong. Try again.";

export function BankSettingsPage() {
  const [profile, setProfile] = useState<BankProfile | null>(null);
  const [companies, setCompanies] = useState<CompanySecuritySummary[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [branch, setBranch] = useState("");
  const [template, setTemplate] = useState<TemplateForm>(() => blankTemplate([]));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const [nextProfile, nextTemplates, nextCompanies] = await Promise.all([getBankProfile(), listEmailTemplates(), listCompanySecurity()]);
      setProfile(nextProfile); setTemplates(nextTemplates); setCompanies(nextCompanies);
      if (nextProfile) { setAccountName(nextProfile.accountName); setBranch(nextProfile.branch); }
      setTemplate((current) => current.companyId || nextCompanies.length === 0 ? current : { ...current, companyId: nextCompanies[0].id });
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const purchaseTemplates = useMemo(() => templates.filter((item) => item.type === "purchase-sheet-bank"), [templates]);
  const companyTemplates = useMemo(() => templates.filter((item) => item.type === "company-noa"), [templates]);

  const saveProfileForm = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      const next = await saveBankProfile({ accountName, accountNumber, branch });
      setProfile(next); setAccountNumber(""); setMessage("Bank profile saved. The account number is encrypted and shown only in masked form.");
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setSaving(false); }
  };

  const saveTemplateForm = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      const payload = { type: template.type, name: template.name, companyId: template.type === "company-noa" ? template.companyId : undefined, to: template.to, cc: template.cc, subject: template.subject };
      const saved = editingId ? await updateEmailTemplate(editingId, payload) : await createEmailTemplate(payload);
      setTemplates((current) => editingId ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
      setTemplate(blankTemplate(companies)); setEditingId(null); setMessage(editingId ? "Email template updated." : "Email template saved. No email was sent.");
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setSaving(false); }
  };

  const removeTemplate = async (id: string) => {
    if (!window.confirm("Delete this saved email template?")) return;
    setSaving(true); setError("");
    try { await deleteEmailTemplate(id); setTemplates((current) => current.filter((item) => item.id !== id)); if (editingId === id) { setEditingId(null); setTemplate(blankTemplate(companies)); } setMessage("Email template deleted."); }
    catch (nextError) { setError(errorMessage(nextError)); }
    finally { setSaving(false); }
  };
  const chooseTemplate = async (id: string) => {
    setSaving(true); setError("");
    try { const selected = await selectEmailTemplate(id); setTemplates((current) => current.map((item) => item.type === selected.type && item.companyId === selected.companyId ? { ...item, selected: item.id === selected.id } : item)); setMessage("Template selected for this email context."); }
    catch (nextError) { setError(errorMessage(nextError)); }
    finally { setSaving(false); }
  };
  const editTemplate = (item: EmailTemplate) => { setEditingId(item.id); setTemplate(templateToForm(item)); setMessage(""); setError(""); };

  return <section className="panel bank-settings-panel">
    <div className="panel-head"><div><p className="eyebrow">Settings / Bank</p><h2>Bank profile and email templates</h2></div><span className="panel-kicker">Configuration only</span></div>
    {loading ? <div className="inline-state">Loading bank configuration…</div> : <div className="bank-settings-body">
      <div className="bank-settings-grid">
        <form className="bank-card" onSubmit={(event) => void saveProfileForm(event)}>
          <div className="bank-card-head"><div><p className="eyebrow">Current account</p><h3>Bank profile</h3></div><span className="chip synced">Encrypted</span></div>
          <p className="bank-help">Keep one current bank/account profile for purchase sheet preparation. Account numbers are encrypted at rest and never returned in full.</p>
          <label><span>Account Name</span><input required value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Tender Tracker Account" /></label>
          <label><span>Account Number <small>{profile?.accountNumberMasked ? `Saved as ${profile.accountNumberMasked}` : "Required for first save"}</small></span><input required={!profile} value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} placeholder={profile?.accountNumberMasked ?? "Enter account number"} autoComplete="off" /></label>
          <label><span>Branch</span><input required value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Motijheel Branch" /></label>
          <button className="primary" disabled={saving}>{saving ? "Saving…" : "Save bank profile"}</button>
        </form>
        <form className="bank-card" onSubmit={(event) => void saveTemplateForm(event)}>
          <div className="bank-card-head"><div><p className="eyebrow">Saved configuration</p><h3>{editingId ? "Edit email template" : "New email template"}</h3></div>{editingId && <button type="button" className="text-button" onClick={() => { setEditingId(null); setTemplate(blankTemplate(companies)); }}>Cancel edit</button>}</div>
          <p className="bank-help">Choose a template when preparing a message. This page never sends email.</p>
          <div className="form-grid compact-grid">
            <label><span>Template type</span><select value={template.type} onChange={(event) => setTemplate((current) => ({ ...current, type: event.target.value as EmailTemplateType }))}><option value="purchase-sheet-bank">Purchase sheet bank email</option><option value="company-noa">Company / NOA email</option></select></label>
            <label><span>Template name</span><input required value={template.name} onChange={(event) => setTemplate((current) => ({ ...current, name: event.target.value }))} placeholder="Bank purchase request" /></label>
            {template.type === "company-noa" && <label className="full-field"><span>Company</span><select required value={template.companyId} onChange={(event) => setTemplate((current) => ({ ...current, companyId: event.target.value }))}><option value="">Select company</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>}
            <label><span>To</span><input required type="email" value={template.to} onChange={(event) => setTemplate((current) => ({ ...current, to: event.target.value }))} placeholder="recipient@example.com" /></label>
            <label><span>CC <small>Optional</small></span><input type="text" value={template.cc} onChange={(event) => setTemplate((current) => ({ ...current, cc: event.target.value }))} placeholder="copy@example.com" /></label>
            <label className="full-field"><span>Subject</span><input required value={template.subject} onChange={(event) => setTemplate((current) => ({ ...current, subject: event.target.value }))} placeholder="Purchase sheet {{sheetNumber}}" /></label>
          </div>
          <button className="primary" disabled={saving}>{saving ? "Saving…" : editingId ? "Save template changes" : "Save email template"}</button>
        </form>
      </div>
      {(message || error) && <div className={error ? "form-error" : "notice"}>{error || message}</div>}
      <TemplateList title="Purchase sheet bank email" items={purchaseTemplates} saving={saving} onSelect={chooseTemplate} onEdit={editTemplate} onDelete={removeTemplate} />
      <TemplateList title="Company / NOA email" items={companyTemplates} saving={saving} onSelect={chooseTemplate} onEdit={editTemplate} onDelete={removeTemplate} />
    </div>}
  </section>;
}

function TemplateList({ title, items, saving, onSelect, onEdit, onDelete }: { title: string; items: EmailTemplate[]; saving: boolean; onSelect: (id: string) => void; onEdit: (item: EmailTemplate) => void; onDelete: (id: string) => void }) {
  return <div className="template-list"><div className="template-list-head"><h3>{title}</h3><span>{items.length} saved</span></div>{items.length ? items.map((item) => <div className="template-row" key={item.id}><div className="template-copy"><strong>{item.name}</strong><span>{item.companyName ? `${item.companyName} · ` : ""}To {item.to}{item.cc ? ` · CC ${item.cc}` : ""}</span><small>{item.subject}</small></div><div className="template-actions">{item.selected ? <span className="chip selected-chip">Selected</span> : <button className="secondary" disabled={saving} onClick={() => void onSelect(item.id)}>Use template</button>}<button className="row-action" disabled={saving} onClick={() => onEdit(item)} aria-label={`Edit ${item.name}`}>Edit</button><button className="row-action danger-action" disabled={saving} onClick={() => void onDelete(item.id)} aria-label={`Delete ${item.name}`}>Delete</button></div></div>) : <div className="template-empty">No templates saved for this context yet.</div>}</div>;
}
