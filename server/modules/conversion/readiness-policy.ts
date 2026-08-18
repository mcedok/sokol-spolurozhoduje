export interface ReadinessSnapshot {
  avStatus: "pending" | "clean" | "infected" | "error";
  jobStatus: string;
  blockCount: number;
  openBlockingFindings: number;
  unconfirmedTables: number;
  missingAltTexts: number;
  missingTableAssets: number;
}

export type ReadinessFailureCode =
  | "AV_NOT_CLEAN"
  | "CONVERSION_NOT_COMPLETE"
  | "NO_BLOCKS"
  | "BLOCKING_FINDINGS"
  | "TABLE_DECISION_REQUIRED"
  | "ALT_TEXT_REQUIRED"
  | "TABLE_ASSET_REQUIRED";

export interface ReadinessFailure {
  code: ReadinessFailureCode;
  message: string;
}

export function readinessFailures(snapshot: ReadinessSnapshot): ReadinessFailure[] {
  const failures: ReadinessFailure[] = [];
  if (snapshot.avStatus !== "clean") failures.push({
    code: "AV_NOT_CLEAN",
    message: "Soubor není bezpečnostně ověřen.",
  });
  if (snapshot.jobStatus !== "completed") failures.push({
    code: "CONVERSION_NOT_COMPLETE",
    message: "Převod není dokončen.",
  });
  if (snapshot.blockCount < 1) failures.push({
    code: "NO_BLOCKS",
    message: "Dokument neobsahuje platný blok.",
  });
  if (snapshot.openBlockingFindings > 0) failures.push({
    code: "BLOCKING_FINDINGS",
    message: "Zůstávají závažné nálezy.",
  });
  if (snapshot.unconfirmedTables > 0) failures.push({
    code: "TABLE_DECISION_REQUIRED",
    message: "Potvrďte zobrazení tabulek.",
  });
  if (snapshot.missingAltTexts > 0) failures.push({
    code: "ALT_TEXT_REQUIRED",
    message: "Doplňte alternativní popisy.",
  });
  if (snapshot.missingTableAssets > 0) failures.push({
    code: "TABLE_ASSET_REQUIRED",
    message: "Doplňte soubory vyžadované zvoleným zobrazením tabulky.",
  });
  return failures;
}
