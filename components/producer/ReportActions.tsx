"use client";

import { useT } from "@/components/locale";

// The print button is the whole export mechanism: the browser's print-to-PDF
// renders the sheet (report.css strips the app chrome in @media print), so
// nothing is generated or stored server-side — the exports rule.

export default function ReportActions() {
  const { tt } = useT();
  return (
    <div className="report-actions report-no-print">
      <button type="button" className="btn btn-primary" onClick={() => window.print()}>
        {tt("rp.print")}
      </button>
      <p className="hint">{tt("rp.printHint")}</p>
    </div>
  );
}
