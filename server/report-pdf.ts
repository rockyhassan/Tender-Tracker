import PDFDocument from "pdfkit";
import type { ReportData } from "./import-report-service";

const moneyColumns = /value|amount|cost|charge|security|quoted|pay order/i;
const formatMoney = (value: unknown) => `BDT ${new Intl.NumberFormat("en-BD", { maximumFractionDigits: 0, useGrouping: true }).format(typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0)}`;
const display = (value: unknown, column: string) => {
  if (value == null || value === "") return "—";
  if (typeof value === "number" && moneyColumns.test(column)) return formatMoney(value);
  return String(value);
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Render a report as a compact, readable landscape PDF. The renderer owns pagination so large reports do not clip rows. */
export function reportPdf(report: ReportData, context: Record<string, unknown> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 32, autoFirstPage: true, compress: false, info: { Title: report.title, Author: "Tender Tracker" } });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    const left = document.page.margins.left;
    const right = document.page.width - document.page.margins.right;
    const bottom = document.page.height - document.page.margins.bottom;
    const widths = report.columns.map((column) => {
      const weight = /remarks|package|company|authority|payee|provider/i.test(column) ? 1.7 : /date|closing|submission|issued|expires|deadline/i.test(column) ? 1.25 : 1;
      return weight;
    });
    const widthTotal = widths.reduce((sum, width) => sum + width, 0);
    const columnWidths = widths.map((width) => ((right - left) * width) / widthTotal);
    const rowHeight = 17;
    const headerHeight = 23;
    let y = 0;
    let pageNumber = 0;

    const drawHeader = () => {
      pageNumber += 1;
      y = 32;
      document.fillColor("#173d43").font("Helvetica-Bold").fontSize(17).text(report.title, left, y);
      y += 23;
      document.fillColor("#50666a").font("Helvetica").fontSize(8).text(`Generated ${new Date().toLocaleString("en-BD")} · ${report.rows.length} row${report.rows.length === 1 ? "" : "s"}`, left, y);
      const contextEntries = Object.entries(context).filter(([, value]) => value !== undefined && value !== "");
      if (contextEntries.length) {
        y += 13;
        document.fillColor("#50666a").fontSize(8).text(`Filters / context: ${contextEntries.map(([key, value]) => `${key}=${String(value)}`).join(" · ")}`, left, y, { width: right - left, ellipsis: true });
      }
      y += 17;
      drawColumnHeaders();
    };
    const drawColumnHeaders = () => {
      let x = left;
      document.fillColor("#e8f1ef").rect(left, y, right - left, headerHeight).fill();
      report.columns.forEach((column, index) => {
        document.fillColor("#173d43").font("Helvetica-Bold").fontSize(7.5).text(column, x + 3, y + 7, { width: columnWidths[index] - 6, lineBreak: false, ellipsis: true });
        x += columnWidths[index];
      });
      document.strokeColor("#b8cfca").lineWidth(0.5).moveTo(left, y + headerHeight).lineTo(right, y + headerHeight).stroke();
      y += headerHeight;
    };
    const drawFooter = () => {
      document.fillColor("#6b7c80").font("Helvetica").fontSize(7).text(`Tender Tracker · page ${pageNumber}`, left, bottom + 12, { width: right - left, align: "right" });
    };

    drawHeader();
    report.rows.forEach((row, rowIndex) => {
      if (y + rowHeight > bottom) { drawFooter(); document.addPage(); drawHeader(); }
      const fill = rowIndex % 2 === 0 ? "#ffffff" : "#f7faf9";
      document.fillColor(fill).rect(left, y, right - left, rowHeight).fill();
      let x = left;
      report.columns.forEach((column, index) => {
        document.fillColor("#21383c").font("Helvetica").fontSize(7.2).text(display(row[column], column), x + 3, y + 5, { width: clamp(columnWidths[index] - 6, 10, 500), height: rowHeight - 5, lineBreak: false, ellipsis: true });
        x += columnWidths[index];
      });
      document.strokeColor("#d8e4e1").lineWidth(0.3).moveTo(left, y + rowHeight).lineTo(right, y + rowHeight).stroke();
      y += rowHeight;
    });
    drawFooter();
    document.end();
  });
}
