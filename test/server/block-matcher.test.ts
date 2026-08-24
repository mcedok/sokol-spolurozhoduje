import { describe, expect, it } from "vitest";

interface MatchBlock {
  blockRevisionId: string;
  blockUid: string;
  order: number;
  type: "heading" | "paragraph";
  plainText: string;
  normalizedHash: string;
  sourceParaId?: string;
  sourceBookmark?: string;
  previousSourceHash?: string;
  nextSourceHash?: string;
}

const ids = {
  source1: "018f6f9d-7e10-7000-8000-000000000001",
  source2: "018f6f9d-7e10-7000-8000-000000000002",
  target1: "018f6f9d-7e10-7000-8000-000000000003",
  target2: "018f6f9d-7e10-7000-8000-000000000004",
  uid1: "018f6f9d-7e10-7000-8000-000000000011",
  uid2: "018f6f9d-7e10-7000-8000-000000000012",
  uid3: "018f6f9d-7e10-7000-8000-000000000013",
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function block(input: Partial<MatchBlock> & Pick<MatchBlock, "blockRevisionId" | "blockUid">): MatchBlock {
  return {
    order: 0,
    type: "paragraph",
    plainText: "Jednoznačný text odstavce.",
    normalizedHash: HASH_A,
    ...input,
  };
}

async function loadMatcher() {
  const modulePath = "../../server/modules/versioning/block-matcher";
  return import(modulePath) as Promise<{
    matchBlocks(input: { source: MatchBlock[]; target: MatchBlock[] }): {
      algorithmVersion: string;
      mappings: Array<{
        sourceRevisionIds: string[];
        targetRevisionIds: string[];
        relation: string;
        confidence: number;
        method: string;
        reviewStatus: string;
      }>;
    };
  }>;
}

describe("deterministic block matcher", () => {
  it("keeps an unchanged stable block automatically confirmed", async () => {
    const { matchBlocks } = await loadMatcher();
    const result = matchBlocks({
      source: [block({ blockRevisionId: ids.source1, blockUid: ids.uid1 })],
      target: [block({ blockRevisionId: ids.target1, blockUid: ids.uid1 })],
    });

    expect(result.algorithmVersion).toBe("block-map-v1");
    expect(result.mappings).toEqual([{
      sourceRevisionIds: [ids.source1],
      targetRevisionIds: [ids.target1],
      relation: "unchanged",
      confidence: 1,
      method: "stable_uid",
      reviewStatus: "auto_confirmed",
    }]);
  });

  it("distinguishes a moved exact block from an edited source-identified block", async () => {
    const { matchBlocks } = await loadMatcher();
    const result = matchBlocks({
      source: [
        block({ blockRevisionId: ids.source1, blockUid: ids.uid1, order: 0 }),
        block({
          blockRevisionId: ids.source2,
          blockUid: ids.uid2,
          order: 1,
          normalizedHash: HASH_B,
          plainText: "Původní znění pravidla.",
          sourceParaId: "para-2",
        }),
      ],
      target: [
        block({ blockRevisionId: ids.target1, blockUid: ids.uid1, order: 2 }),
        block({
          blockRevisionId: ids.target2,
          blockUid: ids.uid3,
          order: 1,
          normalizedHash: HASH_C,
          plainText: "Nové přesnější znění pravidla.",
          sourceParaId: "para-2",
        }),
      ],
    });

    expect(result.mappings).toEqual([
      {
        sourceRevisionIds: [ids.source1],
        targetRevisionIds: [ids.target1],
        relation: "moved",
        confidence: 1,
        method: "stable_uid",
        reviewStatus: "auto_confirmed",
      },
      {
        sourceRevisionIds: [ids.source2],
        targetRevisionIds: [ids.target2],
        relation: "modified",
        confidence: 0.98,
        method: "source_identity",
        reviewStatus: "auto_confirmed",
      },
    ]);
  });

  it("reports unmatched source and target blocks without inventing a mapping", async () => {
    const { matchBlocks } = await loadMatcher();
    const result = matchBlocks({
      source: [block({ blockRevisionId: ids.source1, blockUid: ids.uid1 })],
      target: [block({
        blockRevisionId: ids.target1,
        blockUid: ids.uid2,
        plainText: "Zcela jiný obsah.",
        normalizedHash: HASH_B,
      })],
    });

    expect(result.mappings).toEqual([
      {
        sourceRevisionIds: [ids.source1],
        targetRevisionIds: [],
        relation: "removed",
        confidence: 1,
        method: "unmatched",
        reviewStatus: "auto_confirmed",
      },
      {
        sourceRevisionIds: [],
        targetRevisionIds: [ids.target1],
        relation: "added",
        confidence: 1,
        method: "unmatched",
        reviewStatus: "auto_confirmed",
      },
    ]);
  });

  it("leaves an equally plausible fuzzy match for administrator review", async () => {
    const { matchBlocks } = await loadMatcher();
    const sourceText = "Jednota předloží výroční zprávu do konce března.";
    const targetText = "Jednota předloží výroční zprávu nejpozději do konce března.";
    const result = matchBlocks({
      source: [
        block({
          blockRevisionId: ids.source1,
          blockUid: ids.uid1,
          plainText: sourceText,
          normalizedHash: HASH_A,
        }),
        block({
          blockRevisionId: ids.source2,
          blockUid: ids.uid2,
          plainText: sourceText,
          normalizedHash: HASH_B,
        }),
      ],
      target: [block({
        blockRevisionId: ids.target1,
        blockUid: ids.uid3,
        plainText: targetText,
        normalizedHash: HASH_C,
      })],
    });

    const uncertain = result.mappings.find((mapping) => mapping.method === "text_similarity");
    expect(uncertain).toMatchObject({
      targetRevisionIds: [ids.target1],
      relation: "modified",
      reviewStatus: "needs_review",
    });
    expect(uncertain?.confidence).toBeGreaterThan(0.7);
  });
});
