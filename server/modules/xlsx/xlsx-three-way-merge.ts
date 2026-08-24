import type { XlsxEditableRow, XlsxRowClassification } from "../../../contracts";

export type XlsxMergeRow = XlsxEditableRow;

function canonical(row: XlsxMergeRow): string {
  return JSON.stringify({
    type: row.type,
    priority: row.priority,
    status: row.status,
    outcome: row.outcome,
    statement: row.statement,
    targetVersionNumber: row.targetVersionNumber,
    responsibleUserId: row.responsibleUserId,
    declaredSettlementDate: row.declaredSettlementDate,
  });
}

export function classifyXlsxRow(
  base: XlsxMergeRow,
  current: XlsxMergeRow,
  incoming: XlsxMergeRow,
  validationErrors: string[] = [],
): XlsxRowClassification {
  if (validationErrors.length > 0) return "invalid";
  const baseJson = canonical(base);
  const currentJson = canonical(current);
  const incomingJson = canonical(incoming);
  if (incomingJson === baseJson) return "unchanged";
  if (incomingJson === currentJson) return "already_current";
  if (currentJson === baseJson) return "safe_change";
  return "conflict";
}
