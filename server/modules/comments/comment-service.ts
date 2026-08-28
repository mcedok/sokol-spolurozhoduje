import type { Sql } from "postgres";
import type { Actor, CommentPriority, CommentType } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit, appendDeniedAudit } from "../audit/audit-writer";
import { AuthError, unauthenticated } from "../identity/auth-errors";
import { appendOutbox } from "../outbox/outbox-writer";

interface CommentCommand {
  type: CommentType;
  text: string;
  priority: CommentPriority;
  participationVersion: number;
  idempotencyKey: string;
}

interface ReplyCommand {
  text: string;
  participationVersion: number;
  idempotencyKey: string;
}

interface CommentVoteCommand {
  value: -1 | 0 | 1;
  commentRowVersion: number;
  participationVersion: number;
  idempotencyKey: string;
}

interface NeedVoteCommand {
  value: "yes" | "no" | null;
  participationVersion: number;
  idempotencyKey: string;
}

async function requireParticipant(sql: Sql, actor: Actor | null, correlationId: string) {
  if (!actor) throw unauthenticated();
  const [user] = await sql<{
    id: string;
    first_name: string;
    last_name: string;
    organization_name: string;
  }[]>`
    select users.id, users.first_name, users.last_name,
      coalesce(organizations.name, '') as organization_name
    from users
    left join organizations on organizations.id=users.organization_id
    where users.id=${actor.userId} and users.status='active'
      and users.email_verified_at is not null
  `;
  if (!user) {
    await appendDeniedAudit(sql, {
      actor,
      action: "comment.participation_denied",
      targetType: "user",
      targetId: actor.userId,
      correlationId,
    });
    throw new AuthError("PARTICIPATION_FORBIDDEN", "Účast vyžaduje aktivní účet s ověřeným e-mailem.", 403);
  }
  return { actor, user };
}

async function nextPublicNumbers(tx: Sql, year: number, includeThread: boolean) {
  const [sequence] = await tx<{ thread_last_value: number; comment_last_value: number }[]>`
    insert into participation_sequences(year,thread_last_value,comment_last_value)
    values (${year},${includeThread ? 1 : 0},1)
    on conflict(year) do update set
      thread_last_value=participation_sequences.thread_last_value + ${includeThread ? 1 : 0},
      comment_last_value=participation_sequences.comment_last_value + 1
    returning thread_last_value,comment_last_value
  `;
  return {
    threadPublicId: includeThread
      ? `VLAK-${year}-${String(sequence.thread_last_value).padStart(6, "0")}`
      : null,
    commentPublicId: `PRIP-${year}-${String(sequence.comment_last_value).padStart(6, "0")}`,
  };
}

async function publicComment(tx: Sql, commentId: string, viewerUserId: string) {
  const [row] = await tx<{
    public_id: string;
    thread_public_id: string;
    block_uid: string;
    target_block_revision_id: string;
    parent_public_id: string | null;
    author_name_snapshot: string;
    organization_name_snapshot: string;
    created_at: Date;
    body: string;
    comment_type: CommentType;
    priority: CommentPriority;
    status: "open" | "under_review" | "settled" | "withdrawn" | "hidden";
    row_version: number;
    score: number;
    current_user_vote: -1 | 1 | null;
  }[]>`
    select comment.public_id, thread.public_id as thread_public_id, thread.block_uid,
      thread.target_block_revision_id, parent.public_id as parent_public_id,
      comment.author_name_snapshot, comment.organization_name_snapshot,
      comment.created_at, comment.body, comment.comment_type, comment.priority,
      comment.status, comment.row_version,
      coalesce(sum(vote.value),0)::int as score,
      max(vote.value) filter (where vote.user_id=${viewerUserId})::int as current_user_vote
    from comments comment
    join comment_threads thread on thread.id=comment.thread_id
    left join comments parent on parent.id=comment.parent_comment_id
    left join comment_votes vote on vote.comment_id=comment.id
    where comment.id=${commentId}
    group by comment.id,thread.id,parent.public_id
  `;
  if (!row) throw new AuthError("NOT_FOUND", "Připomínka nebyla nalezena.", 404);
  return {
    publicId: row.public_id,
    threadPublicId: row.thread_public_id,
    blockUid: row.block_uid,
    blockRevisionId: row.target_block_revision_id,
    parentPublicId: row.parent_public_id,
    authorName: row.author_name_snapshot,
    organizationName: row.organization_name_snapshot,
    createdAt: row.created_at.toISOString(),
    text: row.body,
    type: row.comment_type,
    priority: row.priority,
    status: row.status,
    rowVersion: row.row_version,
    score: row.score,
    currentUserVote: row.current_user_vote,
    settlement: null,
  };
}

function documentYear(publicId: string): number {
  const match = /^SOKOL-(\d{4})-\d{3,}$/.exec(publicId);
  if (!match) throw new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);
  return Number(match[1]);
}

export function createCommentService({ sql }: { sql: Sql }) {
  async function replay(tx: Sql, idempotencyKey: string, eventType: string, userId: string) {
    const [existing] = await tx<{ event_type: string; aggregate_id: string }[]>`
      select event_type,aggregate_id from outbox_events where idempotency_key=${idempotencyKey}
    `;
    if (!existing) return null;
    if (existing.event_type !== eventType) {
      throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
    }
    const [document] = await tx<{ participation_version: number }[]>`
      select document.participation_version
      from comments comment
      join comment_threads thread on thread.id=comment.thread_id
      join documents document on document.id=thread.document_id
      where comment.id=${existing.aggregate_id}
    `;
    return {
      comment: await publicComment(tx, existing.aggregate_id, userId),
      participationVersion: document.participation_version,
    };
  }

  return {
    async createComment(actorInput: Actor | null, publicId: string, blockUid: string,
      input: CommentCommand, correlationId = crypto.randomUUID()) {
      const { actor, user } = await requireParticipant(sql, actorInput, correlationId);
      return withTransaction(sql, async (tx) => {
        const replayed = await replay(tx, input.idempotencyKey, "comment.created", actor.userId);
        if (replayed) return replayed;
        const [target] = await tx<{
          document_id: string; participation_version: number; comments_open: boolean;
          status: string; block_revision_id: string; commentable: boolean;
        }[]>`
          select document.id as document_id,document.participation_version,
            document.comments_open,document.status::text,
            revision.block_revision_id,revision.commentable
          from documents document
          join lateral (
            select id from document_versions
            where document_id=document.id and status='ready'
            order by version_number desc limit 1
          ) version on true
          join block_revisions revision on revision.document_version_id=version.id
            and revision.block_uid=${blockUid} and revision.superseded_at is null
          where document.number=${publicId}
          for update of document
        `;
        if (!target) throw new AuthError("NOT_FOUND", "Blok dokumentu nebyl nalezen.", 404);
        if (!target.comments_open || target.status !== "published_open") {
          throw new AuthError("COMMENTS_CLOSED", "Připomínkování je uzavřené.", 409);
        }
        if (!target.commentable) throw new AuthError("BLOCK_NOT_COMMENTABLE", "Tento blok nelze připomínkovat.", 409);
        if (target.participation_version !== input.participationVersion) {
          throw new AuthError("VERSION_CONFLICT", "Diskuse byla mezitím změněna.", 409);
        }
        const numbers = await nextPublicNumbers(tx, documentYear(publicId), true);
        const threadId = crypto.randomUUID();
        const commentId = crypto.randomUUID();
        await tx`
          insert into comment_threads(
            id,public_id,document_id,block_uid,target_block_revision_id,created_by_user_id
          ) values (
            ${threadId},${numbers.threadPublicId},${target.document_id},${blockUid},
            ${target.block_revision_id},${actor.userId}
          )
        `;
        await tx`
          insert into comments(
            id,public_id,thread_id,author_user_id,author_name_snapshot,
            organization_name_snapshot,body,comment_type,priority
          ) values (
            ${commentId},${numbers.commentPublicId},${threadId},${actor.userId},
            ${`${user.first_name} ${user.last_name}`.trim()},${user.organization_name},
            ${input.text.trim()},${input.type},${input.priority}
          )
        `;
        const [document] = await tx<{ participation_version: number }[]>`
          update documents set participation_version=participation_version+1
          where id=${target.document_id} returning participation_version
        `;
        await appendOutbox(tx, {
          eventType: "comment.created", aggregateType: "comment", aggregateId: commentId,
          idempotencyKey: input.idempotencyKey, payload: { publicId: numbers.commentPublicId },
        });
        await appendAudit(tx, {
          actor, action: "comment.created", targetType: "comment", targetId: commentId,
          correlationId, metadata: { documentPublicId: publicId, type: input.type },
        }, "allowed");
        return {
          comment: await publicComment(tx, commentId, actor.userId),
          participationVersion: document.participation_version,
        };
      });
    },

    async reply(actorInput: Actor | null, parentPublicId: string,
      input: ReplyCommand, correlationId = crypto.randomUUID()) {
      const { actor, user } = await requireParticipant(sql, actorInput, correlationId);
      return withTransaction(sql, async (tx) => {
        const replayed = await replay(tx, input.idempotencyKey, "comment.reply_created", actor.userId);
        if (replayed) return replayed;
        const [parent] = await tx<{
          id: string; thread_id: string; document_id: string; participation_version: number;
          comments_open: boolean; status: string; thread_status: string; document_number: string;
        }[]>`
          select parent.id,parent.thread_id,thread.document_id,document.participation_version,
            document.comments_open,document.status::text,thread.status as thread_status,
            document.number as document_number
          from comments parent
          join comment_threads thread on thread.id=parent.thread_id
          join documents document on document.id=thread.document_id
          where parent.public_id=${parentPublicId}
          for update of document,parent,thread
        `;
        if (!parent) throw new AuthError("NOT_FOUND", "Připomínka nebyla nalezena.", 404);
        if (!parent.comments_open || parent.status !== "published_open" || parent.thread_status !== "open") {
          throw new AuthError("COMMENTS_CLOSED", "Připomínkování je uzavřené.", 409);
        }
        if (parent.participation_version !== input.participationVersion) {
          throw new AuthError("VERSION_CONFLICT", "Diskuse byla mezitím změněna.", 409);
        }
        const numbers = await nextPublicNumbers(tx, documentYear(parent.document_number), false);
        const commentId = crypto.randomUUID();
        await tx`
          insert into comments(
            id,public_id,thread_id,parent_comment_id,author_user_id,
            author_name_snapshot,organization_name_snapshot,body,comment_type
          ) values (
            ${commentId},${numbers.commentPublicId},${parent.thread_id},${parent.id},
            ${actor.userId},${`${user.first_name} ${user.last_name}`.trim()},
            ${user.organization_name},${input.text.trim()},'comment'
          )
        `;
        const [document] = await tx<{ participation_version: number }[]>`
          update documents set participation_version=participation_version+1
          where id=${parent.document_id} returning participation_version
        `;
        await appendOutbox(tx, {
          eventType: "comment.reply_created", aggregateType: "comment", aggregateId: commentId,
          idempotencyKey: input.idempotencyKey, payload: { parentPublicId },
        });
        await appendAudit(tx, {
          actor, action: "comment.reply_created", targetType: "comment", targetId: commentId,
          correlationId,
        }, "allowed");
        return {
          comment: await publicComment(tx, commentId, actor.userId),
          participationVersion: document.participation_version,
        };
      });
    },

    async voteComment(actorInput: Actor | null, commentPublicId: string,
      input: CommentVoteCommand, correlationId = crypto.randomUUID()) {
      const { actor } = await requireParticipant(sql, actorInput, correlationId);
      return withTransaction(sql, async (tx) => {
        const [existing] = await tx<{ event_type: string }[]>`
          select event_type from outbox_events where idempotency_key=${input.idempotencyKey}
        `;
        if (existing && existing.event_type !== "comment.vote_changed") {
          throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
        }
        const [target] = await tx<{
          comment_id: string; comment_row_version: number; document_id: string;
          participation_version: number; comments_open: boolean; status: string;
        }[]>`
          select comment.id as comment_id,comment.row_version as comment_row_version,
            document.id as document_id,document.participation_version,
            document.comments_open,document.status::text
          from comments comment
          join comment_threads thread on thread.id=comment.thread_id
          join documents document on document.id=thread.document_id
          where comment.public_id=${commentPublicId}
          for update of comment,document
        `;
        if (!target) throw new AuthError("NOT_FOUND", "Připomínka nebyla nalezena.", 404);
        if (!target.comments_open || target.status !== "published_open") {
          throw new AuthError("COMMENTS_CLOSED", "Hlasování je uzavřené.", 409);
        }
        if (!existing && (target.comment_row_version !== input.commentRowVersion
          || target.participation_version !== input.participationVersion)) {
          throw new AuthError("VERSION_CONFLICT", "Hlasování bylo mezitím změněno.", 409);
        }
        if (!existing) {
          if (input.value === 0) {
            await tx`delete from comment_votes where comment_id=${target.comment_id} and user_id=${actor.userId}`;
          } else {
            await tx`
              insert into comment_votes(comment_id,user_id,value)
              values (${target.comment_id},${actor.userId},${input.value})
              on conflict(comment_id,user_id) do update
              set value=excluded.value,updated_at=now()
            `;
          }
          await tx`update comments set row_version=row_version+1,updated_at=now() where id=${target.comment_id}`;
          await tx`update documents set participation_version=participation_version+1 where id=${target.document_id}`;
          await appendOutbox(tx, {
            eventType: "comment.vote_changed", aggregateType: "comment",
            aggregateId: target.comment_id, idempotencyKey: input.idempotencyKey,
            payload: { value: input.value },
          });
          await appendAudit(tx, {
            actor, action: "comment.vote_changed", targetType: "comment",
            targetId: target.comment_id, correlationId, metadata: { value: input.value },
          }, "allowed");
        }
        const [result] = await tx<{
          score: number; current_user_vote: -1 | 1 | null; row_version: number;
          participation_version: number;
        }[]>`
          select coalesce(sum(vote.value),0)::int as score,
            max(vote.value) filter(where vote.user_id=${actor.userId})::int as current_user_vote,
            comment.row_version,document.participation_version
          from comments comment
          join comment_threads thread on thread.id=comment.thread_id
          join documents document on document.id=thread.document_id
          left join comment_votes vote on vote.comment_id=comment.id
          where comment.id=${target.comment_id}
          group by comment.id,document.id
        `;
        return {
          score: result.score, currentUserVote: result.current_user_vote,
          commentRowVersion: result.row_version,
          participationVersion: result.participation_version,
        };
      });
    },

    async voteNeed(actorInput: Actor | null, publicId: string,
      input: NeedVoteCommand, correlationId = crypto.randomUUID()) {
      const { actor } = await requireParticipant(sql, actorInput, correlationId);
      return withTransaction(sql, async (tx) => {
        const [existing] = await tx<{ event_type: string }[]>`
          select event_type from outbox_events where idempotency_key=${input.idempotencyKey}
        `;
        if (existing && existing.event_type !== "document.need_vote_changed") {
          throw new AuthError("IDEMPOTENCY_CONFLICT", "Klíč požadavku již byl použit.", 409);
        }
        const [document] = await tx<{
          id: string; participation_version: number; comments_open: boolean; status: string;
        }[]>`
          select id,participation_version,comments_open,status::text
          from documents where number=${publicId} for update
        `;
        if (!document) throw new AuthError("NOT_FOUND", "Dokument nebyl nalezen.", 404);
        if (!document.comments_open || document.status !== "published_open") {
          throw new AuthError("COMMENTS_CLOSED", "Hlasování je uzavřené.", 409);
        }
        if (!existing && document.participation_version !== input.participationVersion) {
          throw new AuthError("VERSION_CONFLICT", "Hlasování bylo mezitím změněno.", 409);
        }
        if (!existing) {
          if (input.value === null) {
            await tx`delete from document_need_votes where document_id=${document.id} and user_id=${actor.userId}`;
          } else {
            await tx`
              insert into document_need_votes(document_id,user_id,value)
              values (${document.id},${actor.userId},${input.value})
              on conflict(document_id,user_id) do update
              set value=excluded.value,updated_at=now()
            `;
          }
          await tx`update documents set participation_version=participation_version+1 where id=${document.id}`;
          await appendOutbox(tx, {
            eventType: "document.need_vote_changed", aggregateType: "document",
            aggregateId: document.id, idempotencyKey: input.idempotencyKey,
            payload: { value: input.value },
          });
          await appendAudit(tx, {
            actor, action: "document.need_vote_changed", targetType: "document",
            targetId: document.id, correlationId, metadata: { value: input.value },
          }, "allowed");
        }
        const [result] = await tx<{
          yes: number; no: number; current_user_vote: "yes" | "no" | null;
          participation_version: number;
        }[]>`
          select count(*) filter(where vote.value='yes')::int as yes,
            count(*) filter(where vote.value='no')::int as no,
            max(vote.value) filter(where vote.user_id=${actor.userId}) as current_user_vote,
            document.participation_version
          from documents document
          left join document_need_votes vote on vote.document_id=document.id
          where document.id=${document.id}
          group by document.id
        `;
        return {
          yes: result.yes, no: result.no, currentUserVote: result.current_user_vote,
          participationVersion: result.participation_version,
        };
      });
    },
  };
}
