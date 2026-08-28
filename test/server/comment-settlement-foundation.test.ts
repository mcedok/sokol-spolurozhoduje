import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as contracts from "../../contracts";
import {
  migrateTestDatabase,
  resetTestDatabase,
  seedActiveAdmin,
  seedActiveMember,
  testSql,
} from "./db-test-context";

beforeAll(migrateTestDatabase);
beforeEach(resetTestDatabase);

describe("comment and settlement foundation", () => {
  it("publishes strict block-targeted comment contracts without private member data", () => {
    expect(contracts).toHaveProperty("publicCommentSchema");
    const publicCommentSchema = Reflect.get(contracts, "publicCommentSchema") as {
      parse(input: unknown): Record<string, unknown>;
    };

    const valid = {
      publicId: "PRIP-2026-000123",
      threadPublicId: "VLAK-2026-000123",
      blockUid: "018f6f9d-7e10-7000-8000-000000000001",
      blockRevisionId: "018f6f9d-7e10-7000-8000-000000000002",
      authorName: "Jan Sokol",
      organizationName: "TJ Sokol Test",
      createdAt: "2026-08-18T12:00:00.000Z",
      text: "Navrhuji přesnější znění.",
      type: "proposal",
      priority: "normal",
      status: "open",
      rowVersion: 1,
      settlement: null,
    };

    expect(publicCommentSchema.parse(valid)).toEqual(valid);
    expect(() => publicCommentSchema.parse({
      ...valid,
      email: "private-canary@example.cz",
      membershipId: "PRIVATE-CANARY",
      internalNote: "PRIVATE-CANARY-NOTE",
    })).toThrow();
  });

  it("creates immutable comment history and settlement tables", async () => {
    const expected = [
      "comment_revisions",
      "comment_status_transitions",
      "comment_threads",
      "comment_votes",
      "comments",
      "document_need_votes",
      "participation_sequences",
      "settlement_block_links",
      "settlement_revisions",
      "settlements",
    ];
    const rows = await testSql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = any(${expected})
      order by table_name
    `;

    expect(rows.map((row) => row.table_name)).toEqual(expected);
  });

  it("rejects a settlement target version from another document", async () => {
    const admin = await seedActiveAdmin();
    const member = await seedActiveMember();
    const documentAId = crypto.randomUUID();
    const documentBId = crypto.randomUUID();
    const versionAId = crypto.randomUUID();
    const versionBId = crypto.randomUUID();
    const blockUid = crypto.randomUUID();
    const blockRevisionId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const commentId = crypto.randomUUID();

    await testSql`
      insert into documents (id, number, title, owner_admin_id)
      values
        (${documentAId}, 'SOKOL-2026-901', 'Dokument A', ${admin.id}),
        (${documentBId}, 'SOKOL-2026-902', 'Dokument B', ${admin.id})
    `;
    await testSql`
      insert into document_versions (
        id, document_id, version_number, status, created_by_user_id
      ) values
        (${versionAId}, ${documentAId}, 1, 'ready', ${admin.id}),
        (${versionBId}, ${documentBId}, 1, 'ready', ${admin.id})
    `;
    await testSql`
      insert into document_blocks (block_uid, document_id)
      values (${blockUid}, ${documentAId})
    `;
    await testSql`
      insert into block_revisions (
        block_revision_id, block_uid, document_version_id, block_order,
        block_type, structured_content, plain_text, normalized_hash,
        parser_version, revision_origin
      ) values (
        ${blockRevisionId}, ${blockUid}, ${versionAId}, 0,
        'paragraph', '{}', 'Text', ${"a".repeat(64)}, 'test', 'converted'
      )
    `;
    await testSql`
      insert into comment_threads (
        id, public_id, document_id, block_uid, target_block_revision_id,
        created_by_user_id
      ) values (
        ${threadId}, 'VLAK-2026-000901', ${documentAId}, ${blockUid},
        ${blockRevisionId}, ${member.id}
      )
    `;
    await testSql`
      insert into comments (
        id, public_id, thread_id, author_user_id, author_name_snapshot,
        organization_name_snapshot, body, comment_type
      ) values (
        ${commentId}, 'PRIP-2026-000901', ${threadId}, ${member.id},
        'Jan Člen', 'TJ Sokol Test', 'Připomínka', 'comment'
      )
    `;

    await expect(testSql`
      insert into settlements (
        id, comment_id, outcome, statement, responsible_user_id,
        settled_by_user_id, target_document_version_id
      ) values (
        ${crypto.randomUUID()}, ${commentId}, 'accepted', 'Zapracováno.',
        ${admin.id}, ${admin.id}, ${versionBId}
      )
    `).rejects.toThrow(/same document/i);
  });
});
