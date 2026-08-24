export interface MatchableBlock {
  blockRevisionId: string;
  blockUid: string;
  order: number;
  type: string;
  plainText: string;
  normalizedHash: string;
  sourceParaId?: string;
  sourceBookmark?: string;
  previousSourceHash?: string;
  nextSourceHash?: string;
}

export type MappingRelation =
  | "unchanged"
  | "modified"
  | "moved"
  | "split"
  | "merged"
  | "removed"
  | "added";

export type MappingReviewStatus =
  | "auto_confirmed"
  | "needs_review"
  | "confirmed"
  | "rejected";

export interface BlockMappingCandidate {
  sourceRevisionIds: string[];
  targetRevisionIds: string[];
  relation: MappingRelation;
  confidence: number;
  method: "stable_uid" | "exact_hash" | "source_identity" | "text_similarity" | "unmatched";
  reviewStatus: MappingReviewStatus;
}

export interface BlockMatchResult {
  algorithmVersion: "block-map-v1";
  mappings: BlockMappingCandidate[];
}

function normalizedTokens(text: string): string[] {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("cs-CZ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenDice(left: string, right: string): number {
  const leftTokens = normalizedTokens(left);
  const rightTokens = normalizedTokens(right);
  if (!leftTokens.length && !rightTokens.length) return 1;
  if (!leftTokens.length || !rightTokens.length) return 0;

  const remaining = new Map<string, number>();
  for (const token of rightTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  let intersection = 0;
  for (const token of leftTokens) {
    const count = remaining.get(token) ?? 0;
    if (count > 0) {
      intersection += 1;
      remaining.set(token, count - 1);
    }
  }
  return (2 * intersection) / (leftTokens.length + rightTokens.length);
}

function sourceIdentity(block: MatchableBlock): string | null {
  if (block.sourceBookmark) return `bookmark:${block.sourceBookmark}`;
  if (block.sourceParaId) return `paragraph:${block.sourceParaId}`;
  return null;
}

function oneToOne(
  source: MatchableBlock,
  target: MatchableBlock,
  method: BlockMappingCandidate["method"],
  confidence: number,
  reviewStatus: MappingReviewStatus,
): BlockMappingCandidate {
  const sameContent = source.normalizedHash === target.normalizedHash;
  return {
    sourceRevisionIds: [source.blockRevisionId],
    targetRevisionIds: [target.blockRevisionId],
    relation: sameContent
      ? source.order === target.order ? "unchanged" : "moved"
      : "modified",
    confidence,
    method,
    reviewStatus,
  };
}

export function matchBlocks(input: {
  source: MatchableBlock[];
  target: MatchableBlock[];
}): BlockMatchResult {
  const source = [...input.source].sort((a, b) => a.order - b.order || a.blockRevisionId.localeCompare(b.blockRevisionId));
  const target = [...input.target].sort((a, b) => a.order - b.order || a.blockRevisionId.localeCompare(b.blockRevisionId));
  const unmatchedSource = new Map(source.map((block) => [block.blockRevisionId, block]));
  const unmatchedTarget = new Map(target.map((block) => [block.blockRevisionId, block]));
  const mappings: BlockMappingCandidate[] = [];

  const accept = (
    sourceBlock: MatchableBlock,
    targetBlock: MatchableBlock,
    method: BlockMappingCandidate["method"],
    confidence: number,
    reviewStatus: MappingReviewStatus,
  ) => {
    mappings.push(oneToOne(sourceBlock, targetBlock, method, confidence, reviewStatus));
    unmatchedSource.delete(sourceBlock.blockRevisionId);
    unmatchedTarget.delete(targetBlock.blockRevisionId);
  };

  for (const sourceBlock of source) {
    if (!unmatchedSource.has(sourceBlock.blockRevisionId)) continue;
    const targetBlock = [...unmatchedTarget.values()].find(
      (candidate) => candidate.blockUid === sourceBlock.blockUid,
    );
    if (targetBlock) accept(sourceBlock, targetBlock, "stable_uid", 1, "auto_confirmed");
  }

  for (const sourceBlock of source) {
    if (!unmatchedSource.has(sourceBlock.blockRevisionId)) continue;
    const candidates = [...unmatchedTarget.values()].filter(
      (candidate) => candidate.normalizedHash === sourceBlock.normalizedHash,
    );
    const sameHashSources = [...unmatchedSource.values()].filter(
      (candidate) => candidate.normalizedHash === sourceBlock.normalizedHash,
    );
    if (candidates.length === 1 && sameHashSources.length === 1) {
      accept(sourceBlock, candidates[0], "exact_hash", 1, "auto_confirmed");
    }
  }

  for (const sourceBlock of source) {
    if (!unmatchedSource.has(sourceBlock.blockRevisionId)) continue;
    const identity = sourceIdentity(sourceBlock);
    if (!identity) continue;
    const candidates = [...unmatchedTarget.values()].filter(
      (candidate) => sourceIdentity(candidate) === identity,
    );
    const sameIdentitySources = [...unmatchedSource.values()].filter(
      (candidate) => sourceIdentity(candidate) === identity,
    );
    if (candidates.length === 1 && sameIdentitySources.length === 1) {
      accept(sourceBlock, candidates[0], "source_identity", 0.98, "auto_confirmed");
    }
  }

  for (const targetBlock of target) {
    if (!unmatchedTarget.has(targetBlock.blockRevisionId)) continue;
    const candidates = [...unmatchedSource.values()]
      .filter((candidate) => candidate.type === targetBlock.type)
      .map((candidate) => ({
        block: candidate,
        score: tokenDice(candidate.plainText, targetBlock.plainText),
      }))
      .filter((candidate) => candidate.score >= 0.7)
      .sort((left, right) => right.score - left.score
        || left.block.blockRevisionId.localeCompare(right.block.blockRevisionId));
    if (!candidates.length) continue;

    const best = candidates[0];
    const margin = best.score - (candidates[1]?.score ?? 0);
    const reviewStatus: MappingReviewStatus = margin >= 0.12
      ? "auto_confirmed"
      : "needs_review";
    accept(
      best.block,
      targetBlock,
      "text_similarity",
      Number(best.score.toFixed(3)),
      reviewStatus,
    );
  }

  for (const sourceBlock of source) {
    if (!unmatchedSource.has(sourceBlock.blockRevisionId)) continue;
    mappings.push({
      sourceRevisionIds: [sourceBlock.blockRevisionId],
      targetRevisionIds: [],
      relation: "removed",
      confidence: 1,
      method: "unmatched",
      reviewStatus: "auto_confirmed",
    });
  }
  for (const targetBlock of target) {
    if (!unmatchedTarget.has(targetBlock.blockRevisionId)) continue;
    mappings.push({
      sourceRevisionIds: [],
      targetRevisionIds: [targetBlock.blockRevisionId],
      relation: "added",
      confidence: 1,
      method: "unmatched",
      reviewStatus: "auto_confirmed",
    });
  }

  return { algorithmVersion: "block-map-v1", mappings };
}
