import { beforeEach, describe, expect, it, vi } from "vitest";

const { actor, actorForMutation, comments } = vi.hoisted(() => {
  const actor = {
    userId: "0198f413-2a36-7000-8000-000000000001",
    role: "member" as const,
    sessionId: "0198f413-2a36-7000-8000-000000000002",
  };
  return {
    actor,
    actorForMutation: vi.fn().mockResolvedValue(actor),
    comments: {
      createComment: vi.fn(),
      reply: vi.fn(),
      voteComment: vi.fn(),
      voteNeed: vi.fn(),
    },
  };
});

vi.mock("../../server/http/user-route-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../server/http/user-route-utils")>(),
  actorForMutation,
}));

vi.mock("../../server/runtime", () => ({
  getIdentityRuntime: () => ({ comments }),
}));

import { POST as createComment } from "../../app/api/public/documents/[publicId]/blocks/[blockUid]/comments/route";
import { POST as createReply } from "../../app/api/public/comments/[commentPublicId]/replies/route";
import { PUT as voteComment } from "../../app/api/public/comments/[commentPublicId]/vote/route";
import { PUT as voteNeed } from "../../app/api/public/documents/[publicId]/need-vote/route";

const publicId = "SOKOL-2099-770001";
const blockUid = "0198f413-2a36-7000-8000-000000000010";
const commentPublicId = "PRIP-2099-000001";
const key = "0198f413-2a36-7000-8000-000000000020";

function request(path: string, method: "POST" | "PUT", body: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf",
      "idempotency-key": key,
      "if-match": 'W/"7"',
    },
    body: JSON.stringify(body),
  });
}

describe("comment routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes CSRF-authenticated idempotent concurrency commands to the service", async () => {
    comments.createComment.mockResolvedValue({ comment: { publicId: commentPublicId }, participationVersion: 8 });
    comments.reply.mockResolvedValue({ comment: { publicId: "PRIP-2099-000002" }, participationVersion: 8 });
    comments.voteComment.mockResolvedValue({ score: 1, participationVersion: 8 });
    comments.voteNeed.mockResolvedValue({ yes: 1, no: 0, participationVersion: 8 });

    expect((await createComment(
      request(`/api/public/documents/${publicId}/blocks/${blockUid}/comments`, "POST", {
        type: "proposal", text: "Nové znění", priority: "high",
      }),
      { params: Promise.resolve({ publicId, blockUid }) },
    )).status).toBe(201);
    expect((await createReply(
      request(`/api/public/comments/${commentPublicId}/replies`, "POST", { text: "Odpověď" }),
      { params: Promise.resolve({ commentPublicId }) },
    )).status).toBe(201);
    expect((await voteComment(
      request(`/api/public/comments/${commentPublicId}/vote`, "PUT", { value: 1, commentRowVersion: 3 }),
      { params: Promise.resolve({ commentPublicId }) },
    )).status).toBe(200);
    expect((await voteNeed(
      request(`/api/public/documents/${publicId}/need-vote`, "PUT", { value: "yes" }),
      { params: Promise.resolve({ publicId }) },
    )).status).toBe(200);

    expect(comments.createComment).toHaveBeenCalledWith(actor, publicId, blockUid, {
      type: "proposal", text: "Nové znění", priority: "high",
      participationVersion: 7, idempotencyKey: key,
    }, expect.any(String));
    expect(comments.reply).toHaveBeenCalledWith(actor, commentPublicId, {
      text: "Odpověď", participationVersion: 7, idempotencyKey: key,
    }, expect.any(String));
    expect(comments.voteComment).toHaveBeenCalledWith(actor, commentPublicId, {
      value: 1, commentRowVersion: 3, participationVersion: 7, idempotencyKey: key,
    }, expect.any(String));
    expect(comments.voteNeed).toHaveBeenCalledWith(actor, publicId, {
      value: "yes", participationVersion: 7, idempotencyKey: key,
    }, expect.any(String));
  });
});
