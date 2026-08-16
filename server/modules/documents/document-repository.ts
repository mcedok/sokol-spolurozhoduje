import type { Sql } from "postgres";
import type {
  DocumentAdminView,
  DocumentStatus,
  PublicDocumentSummary,
} from "../../../contracts";

export interface DocumentRow {
  id: string;
  number: string;
  title: string;
  explanatory_report: string;
  owner_admin_id: string;
  responsible_admin_name: string;
  status: DocumentStatus;
  comments_open: boolean;
  visibility_mode: "public_detail" | "login_required_detail";
  four_eyes_required: boolean;
  closure_reason: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

function publicView(row: DocumentRow): PublicDocumentSummary {
  return {
    publicId: row.number,
    title: row.title,
    explanatoryReport: row.explanatory_report,
    responsibleAdminName: row.responsible_admin_name,
    status: row.status,
    commentsOpen: row.comments_open,
    visibilityMode: row.visibility_mode,
    fourEyesRequired: row.four_eyes_required,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function adminView(row: DocumentRow): DocumentAdminView {
  return {
    ...publicView(row),
    id: row.id,
    ownerAdminId: row.owner_admin_id,
    closureReason: row.closure_reason,
    rowVersion: row.row_version,
  };
}

const COLUMNS = `
  documents.id, documents.number, documents.title, documents.explanatory_report,
  documents.owner_admin_id,
  concat_ws(' ', owner.first_name, owner.last_name) as responsible_admin_name,
  documents.status, documents.comments_open, documents.visibility_mode,
  documents.four_eyes_required, documents.closure_reason, documents.row_version,
  documents.created_at, documents.updated_at
`;

export async function findDocumentRow(sql: Sql, documentId: string): Promise<DocumentRow | null> {
  const rows = await sql.unsafe<DocumentRow[]>(`
    select ${COLUMNS}
    from documents join users owner on owner.id = documents.owner_admin_id
    where documents.id = $1
  `, [documentId]);
  return rows[0] ?? null;
}

export async function findDocumentAdminView(
  sql: Sql,
  documentId: string,
): Promise<DocumentAdminView | null> {
  const row = await findDocumentRow(sql, documentId);
  return row ? adminView(row) : null;
}

export async function listPublicDocuments(
  sql: Sql,
  authenticated: boolean,
): Promise<PublicDocumentSummary[]> {
  const rows = await sql.unsafe<DocumentRow[]>(`
    select ${COLUMNS}
    from documents join users owner on owner.id = documents.owner_admin_id
    where documents.status in (
      'published_open', 'comments_closed', 'settlement', 'settled',
      'approved', 'rejected', 'archived'
    )
      and (documents.visibility_mode = 'public_detail' or $1::boolean = true)
    order by documents.created_at desc, documents.id
  `, [authenticated]);
  return rows.map(publicView);
}

export async function findVisibleDocument(
  sql: Sql,
  documentId: string,
  authenticated: boolean,
): Promise<PublicDocumentSummary | null> {
  const rows = await sql.unsafe<DocumentRow[]>(`
    select ${COLUMNS}
    from documents join users owner on owner.id = documents.owner_admin_id
    where documents.id = $1
      and documents.status in (
        'published_open', 'comments_closed', 'settlement', 'settled',
        'approved', 'rejected', 'archived'
      )
      and (documents.visibility_mode = 'public_detail' or $2::boolean = true)
  `, [documentId, authenticated]);
  return rows[0] ? publicView(rows[0]) : null;
}
