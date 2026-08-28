import type { Sql } from "postgres";
import type {
  Actor,
  DocumentStatus,
  PublicCommentThread,
  PublicDocumentBlock,
  PublicDocumentDetail,
} from "../../../contracts";
import { AuthError } from "../identity/auth-errors";

export async function readPublicDocumentDetail(
  sql: Sql,
  actor: Actor | null,
  publicId: string,
): Promise<PublicDocumentDetail> {
  return sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read`;
    const [document] = await tx<{
      id: string;
      number: string;
      title: string;
      explanatory_report: string;
      responsible_admin_name: string;
      status: DocumentStatus;
      comments_open: boolean;
      visibility_mode: "public_detail" | "login_required_detail";
      four_eyes_required: boolean;
      row_version: number;
      participation_version: number;
      created_at: Date;
      updated_at: Date;
    }[]>`
      select document.id, document.number, document.title, document.explanatory_report,
        concat_ws(' ', owner.first_name, owner.last_name) as responsible_admin_name,
        document.status, document.comments_open, document.visibility_mode,
        document.four_eyes_required, document.row_version, document.participation_version,
        document.created_at, document.updated_at
      from documents document
      join users owner on owner.id=document.owner_admin_id
      where document.number=${publicId}
        and document.status in (
          'published_open','comments_closed','settlement','settled',
          'approved','rejected','archived'
        )
        and (document.visibility_mode='public_detail' or ${Boolean(actor)})
    `;
    if (!document) throw new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);

    const [version] = await tx<{
      id: string;
      version_number: number;
      published_at: Date | null;
      original_name: string | null;
    }[]>`
      select version.id, version.version_number, version.published_at, original.original_name
      from document_versions version
      left join file_objects original on original.id=version.original_file_id
      where version.document_id=${document.id} and version.status='ready'
      order by version.version_number desc
      limit 1
    `;
    const blocks = version ? await tx<{
      block_uid: string;
      block_revision_id: string;
      block_type: PublicDocumentBlock["type"];
      block_order: number;
      commentable: boolean;
      plain_text: string;
      structured_content: Record<string, unknown>;
    }[]>`
      select revision.block_uid, revision.block_revision_id, revision.block_type,
        revision.block_order, revision.commentable, revision.plain_text,
        revision.structured_content
      from block_revisions revision
      where revision.document_version_id=${version.id} and revision.superseded_at is null
      order by revision.block_order
    ` : [];
    const comments = version ? await tx<{
      thread_public_id: string;
      block_uid: string;
      target_block_revision_id: string;
      thread_status: PublicCommentThread["status"];
      thread_row_version: number;
      comment_public_id: string;
      parent_public_id: string | null;
      author_name_snapshot: string;
      organization_name_snapshot: string;
      comment_created_at: Date;
      body: string;
      comment_type: "comment" | "proposal" | "question";
      priority: "low" | "normal" | "high" | "critical";
      comment_status: "open" | "under_review" | "settled" | "withdrawn" | "hidden";
      comment_row_version: number;
      score: number;
      current_user_vote: -1 | 1 | null;
      settlement_outcome: "accepted" | "partially_accepted" | "rejected" | "explained_no_change" | "duplicate" | "out_of_scope" | "withdrawn" | null;
      settlement_statement: string | null;
      responsible_admin_name: string | null;
      settled_at: Date | null;
      target_version_number: number | null;
    }[]>`
      select thread.public_id as thread_public_id,thread.block_uid,
        thread.target_block_revision_id,thread.status as thread_status,
        thread.row_version as thread_row_version,
        comment.public_id as comment_public_id,parent.public_id as parent_public_id,
        comment.author_name_snapshot,comment.organization_name_snapshot,
        comment.created_at as comment_created_at,comment.body,comment.comment_type,
        comment.priority,comment.status as comment_status,
        comment.row_version as comment_row_version,
        coalesce(sum(vote.value),0)::int as score,
        max(vote.value) filter(where vote.user_id=${actor?.userId ?? null})::int as current_user_vote,
        settlement.outcome as settlement_outcome,settlement.statement as settlement_statement,
        concat_ws(' ', responsible.first_name, responsible.last_name) as responsible_admin_name,
        settlement.settled_at,target_version.version_number as target_version_number
      from comment_threads thread
      join comments comment on comment.thread_id=thread.id
      left join comments parent on parent.id=comment.parent_comment_id
      left join comment_votes vote on vote.comment_id=comment.id
      left join settlements settlement on settlement.comment_id=comment.id
      left join users responsible on responsible.id=settlement.responsible_user_id
      left join document_versions target_version on target_version.id=settlement.target_document_version_id
      where thread.document_id=${document.id}
        and thread.target_block_revision_id in (
          select block_revision_id from block_revisions
          where document_version_id=${version.id} and superseded_at is null
        )
        and thread.status <> 'hidden' and comment.status <> 'hidden'
      group by thread.id,comment.id,parent.public_id,settlement.id,
        responsible.id,target_version.version_number
      order by thread.created_at,thread.id,comment.created_at,comment.id
    ` : [];
    const threadMap = new Map<string, PublicCommentThread>();
    for (const row of comments) {
      let thread = threadMap.get(row.thread_public_id);
      if (!thread) {
        thread = {
          publicId: row.thread_public_id,
          blockUid: row.block_uid,
          blockRevisionId: row.target_block_revision_id,
          status: row.thread_status,
          rowVersion: row.thread_row_version,
          comments: [],
        };
        threadMap.set(row.thread_public_id, thread);
      }
      thread.comments.push({
        publicId: row.comment_public_id,
        threadPublicId: row.thread_public_id,
        blockUid: row.block_uid,
        blockRevisionId: row.target_block_revision_id,
        parentPublicId: row.parent_public_id,
        authorName: row.author_name_snapshot,
        organizationName: row.organization_name_snapshot,
        createdAt: row.comment_created_at.toISOString(),
        text: row.body,
        type: row.comment_type,
        priority: row.priority,
        status: row.comment_status,
        rowVersion: row.comment_row_version,
        score: row.score,
        currentUserVote: row.current_user_vote,
        settlement: row.settlement_outcome ? {
          outcome: row.settlement_outcome,
          statement: row.settlement_statement!,
          responsibleAdminName: row.responsible_admin_name!,
          settledAt: row.settled_at!.toISOString(),
          targetVersionNumber: row.target_version_number,
        } : null,
      });
    }
    const [needVotes] = await tx<{
      yes: number;
      no: number;
      current_user_vote: "yes" | "no" | null;
    }[]>`
      select count(*) filter(where vote.value='yes')::int as yes,
        count(*) filter(where vote.value='no')::int as no,
        max(vote.value) filter(where vote.user_id=${actor?.userId ?? null}) as current_user_vote
      from document_need_votes vote where vote.document_id=${document.id}
    `;

    return {
      publicId: document.number,
      title: document.title,
      explanatoryReport: document.explanatory_report,
      responsibleAdminName: document.responsible_admin_name,
      status: document.status,
      commentsOpen: document.comments_open,
      visibilityMode: document.visibility_mode,
      fourEyesRequired: document.four_eyes_required,
      createdAt: document.created_at.toISOString(),
      updatedAt: document.updated_at.toISOString(),
      documentRevision: document.row_version,
      participationVersion: document.participation_version,
      version: version ? {
        versionNumber: version.version_number,
        publishedAt: version.published_at?.toISOString() ?? null,
        originalName: version.original_name,
        blocks: blocks.map((block) => ({
          blockUid: block.block_uid,
          blockRevisionId: block.block_revision_id,
          type: block.block_type,
          order: block.block_order,
          commentable: block.commentable,
          text: block.plain_text,
          structuredContent: block.structured_content,
        })),
      } : null,
      threads: [...threadMap.values()],
      needVotes: {
        yes: needVotes.yes,
        no: needVotes.no,
        currentUserVote: needVotes.current_user_vote,
      },
    };
  });
}
