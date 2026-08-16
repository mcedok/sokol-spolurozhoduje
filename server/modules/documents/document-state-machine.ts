import type { DocumentStatus } from "../../../contracts";

export const ALLOWED_DOCUMENT_TRANSITIONS: Record<
  DocumentStatus,
  readonly DocumentStatus[]
> = {
  concept: ["file_check"],
  file_check: ["conversion"],
  conversion: ["conversion_review"],
  conversion_review: ["conversion", "ready"],
  ready: ["published_open"],
  published_open: ["comments_closed"],
  comments_closed: ["published_open", "settlement"],
  settlement: ["settled"],
  settled: ["approved", "rejected"],
  approved: ["archived"],
  rejected: ["archived"],
  archived: [],
};

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return ALLOWED_DOCUMENT_TRANSITIONS[from].includes(to);
}
