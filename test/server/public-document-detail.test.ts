import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDocumentService } from "../../server/modules/documents/document-service";
import { createCommentService } from "../../server/modules/comments/comment-service";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  seedActiveMember,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

async function seedPublishedDocument(visibilityMode: "public_detail" | "login_required_detail" = "public_detail") {
  const owner = await seedActiveAdmin();
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const blockUid = crypto.randomUUID();
  const blockRevisionId = crypto.randomUUID();
  await testSql`
    insert into documents(
      id,number,title,explanatory_report,owner_admin_id,status,comments_open,visibility_mode
    ) values (
      ${documentId},'SOKOL-2099-880001','Veřejná norma','Důvodová zpráva',${owner.id},
      'published_open',true,${visibilityMode}
    )
  `;
  await testSql`
    insert into document_versions(
      id,document_id,version_number,status,created_by_user_id,published_at
    ) values (${versionId},${documentId},3,'ready',${owner.id},now())
  `;
  await testSql`insert into document_blocks(block_uid,document_id) values (${blockUid},${documentId})`;
  await testSql`
    insert into block_revisions(
      block_revision_id,block_uid,document_version_id,block_order,block_type,
      structured_content,plain_text,normalized_hash,parser_version,revision_origin
    ) values (
      ${blockRevisionId},${blockUid},${versionId},0,'paragraph',
      ${testSql.json({ runs: [{ text: "Text normy", bold: true }] })},'Text normy',
      ${"a".repeat(64)},'docx-web-v1','converted'
    )
  `;
  return { documentId, versionId, blockUid, blockRevisionId };
}

describe("public document detail", () => {
  it("returns the latest ready version and stable converted blocks without private data", async () => {
    const seeded = await seedPublishedDocument();
    const documents = createDocumentService({ sql: testSql });
    const readDetail = Reflect.get(documents, "getPublicDocumentDetail") as
      | ((actor: null, publicId: string) => Promise<unknown>)
      | undefined;

    const detail = await readDetail?.(null, "SOKOL-2099-880001");

    expect(detail).toMatchObject({
      publicId: "SOKOL-2099-880001",
      title: "Veřejná norma",
      commentsOpen: true,
      documentRevision: 1,
      version: {
        versionNumber: 3,
        originalName: null,
        blocks: [{
          blockUid: seeded.blockUid,
          blockRevisionId: seeded.blockRevisionId,
          type: "paragraph",
          order: 0,
          commentable: true,
          text: "Text normy",
          structuredContent: { runs: [{ text: "Text normy", bold: true }] },
        }],
      },
      threads: [],
      needVotes: { yes: 0, no: 0, currentUserVote: null },
    });
    expect(JSON.stringify(detail)).not.toMatch(/email|membership|ownerAdminId|originalFileId/i);
  });

  it("requires authentication for a login-only detail while preserving member access", async () => {
    await seedPublishedDocument("login_required_detail");
    const member = await seedActiveMember();
    const documents = createDocumentService({ sql: testSql });
    const readDetail = Reflect.get(documents, "getPublicDocumentDetail") as
      (actor: unknown, publicId: string) => Promise<unknown>;

    await expect(readDetail?.(null, "SOKOL-2099-880001"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readDetail?.({
      userId: member.id,
      role: "member",
      sessionId: crypto.randomUUID(),
    }, "SOKOL-2099-880001")).resolves.toMatchObject({ title: "Veřejná norma" });
  });

  it("returns public threads, replies and vote summaries for the current reader", async () => {
    const seeded = await seedPublishedDocument();
    const member = await seedActiveMember();
    const actor = { userId: member.id, role: "member" as const, sessionId: crypto.randomUUID() };
    const comments = createCommentService({ sql: testSql });
    const created = await comments.createComment(actor, "SOKOL-2099-880001", seeded.blockUid, {
      type: "proposal",
      text: "Navrhuji úpravu.",
      priority: "normal",
      participationVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    await comments.reply(actor, created.comment.publicId, {
      text: "Doplnění návrhu.",
      participationVersion: 2,
      idempotencyKey: crypto.randomUUID(),
    });
    await comments.voteComment(actor, created.comment.publicId, {
      value: 1,
      commentRowVersion: 1,
      participationVersion: 3,
      idempotencyKey: crypto.randomUUID(),
    });
    await comments.voteNeed(actor, "SOKOL-2099-880001", {
      value: "yes",
      participationVersion: 4,
      idempotencyKey: crypto.randomUUID(),
    });

    const detail = await createDocumentService({ sql: testSql })
      .getPublicDocumentDetail(actor, "SOKOL-2099-880001");

    expect(detail).toMatchObject({
      participationVersion: 5,
      needVotes: { yes: 1, no: 0, currentUserVote: "yes" },
      threads: [{
        blockUid: seeded.blockUid,
        comments: [
          { publicId: created.comment.publicId, parentPublicId: null, score: 1, currentUserVote: 1 },
          { parentPublicId: created.comment.publicId, text: "Doplnění návrhu." },
        ],
      }],
    });
  });
});
