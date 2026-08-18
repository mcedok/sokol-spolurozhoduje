import { createElement as h } from "react";

const LABELS = {
  file_check: "Antivirová kontrola",
  scanning: "Antivirová kontrola",
  conversion: "Převod dokumentu",
  parsing: "Rozpoznání struktury",
  rendering: "Příprava referenčního náhledu",
  completed: "Převod dokončen",
  failed: "Převod se nezdařil",
  rejected: "Soubor byl z bezpečnostních důvodů odmítnut",
};

export function ConversionProgress({ processing }) {
  if (!processing) return null;
  const key = processing.jobStatus === "failed" || processing.jobStatus === "rejected"
    ? processing.jobStatus
    : processing.step || processing.versionStatus || processing.jobStatus;
  return h(
    "div",
    { className: `conversionProgress ${key || "pending"}`, role: "status", "aria-live": "polite" },
    h("b", null, LABELS[key] || "Dokument čeká na zpracování"),
    processing.attemptCount > 1 && h("span", null, `Pokus ${processing.attemptCount} ze 3`),
  );
}
