import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../contracts";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  seedActiveMember,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

async function loadFactory() {
  try {
    const module = await import("../../server/modules/comments/comment-service");
    return module.createCommentService;
  } catch {
    return null;
  }
}

async function seedOpenDocument() {
  const owner = await seedActiveAdmin();
  const member = await seedActiveMember();
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const blockUid = crypto.randomUUID();
  const blockRevisionId = crypto.randomUUID();
  await testSql`
    insert into documents(
      id,number,title,owner_admin_id,status,comments_open,participation_version
    ) values (
      ${documentId},'SOKOL-2099-770001','Připomínkovaná norma',${owner.id},
      'published_open',true,1
    )
  `;
  await testSql`
    insert into document_versions(id,document_id,version_number,status,created_by_user_id,published_at)
    values (${versionId},${documentId},1,'ready',${owner.id},now())
  `;
  await testSql`insert into document_blocks(block_uid,document_id) values (${blockUid},${documentId})`;
  await testSql`
    insert into block_revisions(
      block_revision_id,block_uid,document_version_id,block_order,block_type,
      structured_content,plain_text,normalized_hash,parser_version,revision_origin
    ) values (
      ${blockRevisionId},${blockUid},${versionId},0,'paragraph','{}','Text bloku',
      ${"a".repeat(64)},'test','converted'
    )
  `;
  const actor: Actor = { userId: member.id, role: "member", sessionId: crypto.randomUUID() };
  return { actor, member, documentId, blockUid };
}

describe("comment participation workflows", () => {
  it("creates a stable block-targeted proposal idempotently with public author snapshots", async () => {
    const factory = await loadFactory();
    expect(factory).not.toBeNull();
    if (!factory) return;
    const seeded = await seedOpenDocument();
    const comments = factory({ sql: testSql });
    const key = crypto.randomUUID();
    const input = {
      type: "proposal" as const,
      text: "Navrhuji nové znění.",
      priority: "high" as const,
      participationVersion: 1,
      idempotencyKey: key,
    };

    const first = await comments.createComment(
      seeded.actor,
      "SOKOL-2099-770001",
      seeded.blockUid,
      input,
    );
    const replay = await comments.createComment(
      seeded.actor,
      "SOKOL-2099-770001",
      seeded.blockUid,
      input,
    );

    expect(first).toMatchObject({
      comment: {
        publicId: expect.stringMatching(/^PRIP-2099-\d{6}$/),
        threadPublicId: expect.stringMatching(/^VLAK-2099-\d{6}$/),
        blockUid: seeded.blockUid,
        authorName: "Jan Člen",
        organizationName: "Testovací jednota",
        text: "Navrhuji nové znění.",
        type: "proposal",
        priority: "high",
        rowVersion: 1,
      },
      participationVersion: 2,
    });
    expect(replay).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/email|membershipId|authorUserId/i);
    expect(await testSql`select * from comments`).toHaveLength(1);
    expect(await testSql`select * from comment_threads`).toHaveLength(1);
  });

  it("adds a reply and lets a verified user vote on the comment and document need", async () => {
    const factory = await loadFactory();
    expect(factory).not.toBeNull();
    if (!factory) return;
    const seeded = await seedOpenDocument();
    const comments = factory({ sql: testSql });
    const created = await comments.createComment(
      seeded.actor,
      "SOKOL-2099-770001",
      seeded.blockUid,
      {
        type: "comment",
        text: "Prosím o vysvětlení.",
        priority: "normal",
        participationVersion: 1,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    const reply = await comments.reply(seeded.actor, created.comment.publicId, {
      text: "Doplňuji argument.",
      participationVersion: 2,
      idempotencyKey: crypto.randomUUID(),
    });
    const vote = await comments.voteComment(seeded.actor, created.comment.publicId, {
      value: 1,
      commentRowVersion: created.comment.rowVersion,
      participationVersion: 3,
      idempotencyKey: crypto.randomUUID(),
    });
    const needVote = await comments.voteNeed(seeded.actor, "SOKOL-2099-770001", {
      value: "yes",
      participationVersion: 4,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(reply).toMatchObject({ comment: { parentPublicId: created.comment.publicId }, participationVersion: 3 });
    expect(vote).toEqual({ score: 1, currentUserVote: 1, commentRowVersion: 2, participationVersion: 4 });
    expect(needVote).toEqual({ yes: 1, no: 0, currentUserVote: "yes", participationVersion: 5 });
  });

  it("rejects a new contribution after comments are closed", async () => {
    const factory = await loadFactory();
    expect(factory).not.toBeNull();
    if (!factory) return;
    const seeded = await seedOpenDocument();
    await testSql`
      update documents set status='comments_closed',comments_open=false
      where id=${seeded.documentId}
    `;
    const comments = factory({ sql: testSql });

    await expect(comments.createComment(
      seeded.actor,
      "SOKOL-2099-770001",
      seeded.blockUid,
      {
        type: "comment",
        text: "Pozdní komentář.",
        priority: "normal",
        participationVersion: 1,
        idempotencyKey: crypto.randomUUID(),
      },
    )).rejects.toMatchObject({ code: "COMMENTS_CLOSED" });
  });
});
