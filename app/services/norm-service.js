import {
  assertAuthorized,
  canCreateNorm,
  canManageNorm,
  canParticipate,
} from "../security/access-control.js";

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const ACTIVE_STATUSES = new Set(["K připomínkování", "Vypořádání", "Ke schválení"]);
const CLOSED_STATUSES = new Set(["Schváleno", "Neschváleno", "Archivováno"]);
const PARTICIPATION_STATUS = "K připomínkování";
const RESOLUTION_STATUSES = new Set(["Nevypořádáno", "Zapracováno", "Nezapracováno"]);
const UPDATE_FIELDS = new Set([
  "title",
  "category",
  "version",
  "status",
  "commentsOpen",
  "closureReason",
  "publishedAt",
  "deadline",
  "submittedBy",
  "responsible",
  "summary",
  "reason",
]);

const ERROR_MESSAGES = {
  CLOSURE_REASON_REQUIRED: "Při uzavření připomínek uveďte důvod.",
  COMMENTS_CLOSED: "Připomínkování této normy je uzavřeno.",
  FILE_TOO_LARGE: "Soubor může mít nejvýše 15 MB.",
  INVALID_CONTRIBUTION: "Vyplňte název a text příspěvku.",
  INVALID_FILE: "Vyberte platný soubor.",
  INVALID_NORM: "Vyplňte název normy.",
  INVALID_RESOLUTION: "Vyplňte platný výsledek vypořádání.",
  RESOLUTION_REASON_REQUIRED: "Vyplňte odůvodnění vypořádání.",
  INVALID_VOTE: "Hlas nemá platnou hodnotu.",
  NORM_NOT_FOUND: "Norma nebyla nalezena.",
  SUBMISSION_NOT_FOUND: "Podnět nebyl nalezen.",
};

export class NormServiceError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || "Operaci s normou se nepodařilo dokončit.");
    this.name = "NormServiceError";
    this.code = code;
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function displayName(user) {
  return [user.firstName, user.lastName].map(normalizeText).filter(Boolean).join(" ") || user.email;
}

function publicTitle(norm) {
  return {
    id: norm.id,
    title: norm.title,
    visibilityMode: norm.visibilityMode,
  };
}

function assertParticipationOpen(norm) {
  if (!norm.commentsOpen || norm.status !== PARTICIPATION_STATUS) {
    throw new NormServiceError("COMMENTS_CLOSED");
  }
}

export function createNormService({ repository, auth, audit, fileRepository, now }) {
  let generatedIdSequence = 0;

  function uniqueId(prefix) {
    generatedIdSequence += 1;
    return `${prefix}-${now()}-${generatedIdSequence}`;
  }

  function findNorm(state, normId) {
    const norm = state.norms.find((candidate) => candidate.id === normId);
    if (!norm) throw new NormServiceError("NORM_NOT_FOUND");
    return norm;
  }

  function findSubmission(norm, submissionId) {
    const submission = norm.submissions.find((candidate) => candidate.id === submissionId);
    if (!submission) throw new NormServiceError("SUBMISSION_NOT_FOUND");
    return submission;
  }

  function actorIdForSession(sessionId) {
    return repository.read().sessions.find((candidate) => candidate.id === sessionId)?.userId || null;
  }

  function deny(sessionId, code, requestedAction, targetType, targetId) {
    audit.record({
      actorUserId: actorIdForSession(sessionId),
      action: "authorization.denied",
      targetType,
      targetId,
      metadata: { requestedAction, permission: code },
    });
    assertAuthorized(false, code);
  }

  function authorizedSession(sessionId, code, requestedAction, targetType, targetId) {
    try {
      return auth.getSession(sessionId);
    } catch {
      return deny(sessionId, code, requestedAction, targetType, targetId);
    }
  }

  function managedNorm(sessionId, normId, requestedAction) {
    const session = authorizedSession(sessionId, "manage_norm", requestedAction, "norm", normId);
    const norm = findNorm(repository.read(), normId);
    if (!canManageNorm(session.user, norm)) {
      deny(sessionId, "manage_norm", requestedAction, "norm", norm.id);
    }
    return { actor: session.user, norm };
  }

  function creatingActor(sessionId) {
    const session = authorizedSession(sessionId, "create_norm", "norm.create", "norm", null);
    if (!canCreateNorm(session.user)) {
      deny(sessionId, "create_norm", "norm.create", "norm", null);
    }
    return session.user;
  }

  function participatingActor(sessionId, requestedAction, normId) {
    const session = authorizedSession(sessionId, "participate", requestedAction, "norm", normId);
    if (!canParticipate(session.user)) {
      deny(sessionId, "participate", requestedAction, "norm", normId);
    }
    return session.user;
  }

  function recordManagement(actorUserId, action, targetId, metadata = {}) {
    audit.record({ actorUserId, action, targetType: "norm", targetId, metadata });
  }

  function listPublicNorms(filter = "Všechny") {
    const norms = repository.read().norms;
    const filtered =
      filter === "Aktivní"
        ? norms.filter((norm) => ACTIVE_STATUSES.has(norm.status))
        : filter === "Uzavřené"
          ? norms.filter((norm) => CLOSED_STATUSES.has(norm.status))
          : norms;
    return filtered.map((norm) =>
      norm.visibilityMode === "title-only" ? publicTitle(norm) : norm,
    );
  }

  function getPublicNorm(normId, user) {
    const norm = findNorm(repository.read(), normId);
    if (norm.visibilityMode === "title-only" && !canParticipate(user)) return publicTitle(norm);
    return norm;
  }

  function listManageable(sessionId) {
    const session = authorizedSession(sessionId, "manage_norm", "norm.list_manageable", "norm", null);
    if (!canCreateNorm(session.user)) {
      deny(sessionId, "manage_norm", "norm.list_manageable", "norm", null);
    }
    return repository.read().norms.filter((norm) => canManageNorm(session.user, norm));
  }

  async function create(sessionId, input, file) {
    const actor = creatingActor(sessionId);
    const title = normalizeText(input?.title);
    if (!title) throw new NormServiceError("INVALID_NORM");
    if (file && file.size > MAX_FILE_SIZE) throw new NormServiceError("FILE_TOO_LARGE");

    const timestamp = now();
    const year = new Date(timestamp).getFullYear();
    const status = normalizeText(input?.status) || "Koncept";
    const norm = {
      id: uniqueId("norm"),
      number: null,
      title,
      category: normalizeText(input?.category),
      version: normalizeText(input?.version),
      status,
      commentsOpen: CLOSED_STATUSES.has(status)
        ? false
        : input?.commentsOpen ?? status === "K připomínkování",
      closureReason: "",
      publishedAt:
        normalizeText(input?.publishedAt) ||
        (status === "K připomínkování" ? new Date(timestamp).toISOString().slice(0, 10) : ""),
      deadline: normalizeText(input?.deadline),
      submittedBy: normalizeText(input?.submittedBy),
      responsible: normalizeText(input?.responsible),
      summary: normalizeText(input?.summary),
      reason: normalizeText(input?.reason),
      file: null,
      needVotes: { yes: 0, no: 0 },
      sections: [
        {
          id: "document",
          label: "Dokument",
          title: "Text nahraného materiálu",
          paragraphs: [
            "Pro pilotní test je původní soubor dostupný ke stažení. Strukturovaný převod dokumentu bude doplněn v navazující integrační fázi.",
          ],
        },
      ],
      submissions: [],
      ownerAdminId: actor.id,
      visibilityMode: "public-detail",
    };

    if (file && file.size > 0) {
      const fileId = `file-${norm.id}`;
      try {
        await fileRepository.storeFile(fileId, file);
      } catch (error) {
        try {
          await fileRepository.removeFile(fileId);
        } catch {
          // Preserve the original storage error; a failed cleanup is best-effort in this local pilot.
        }
        throw error;
      }
      norm.file = { id: fileId, name: file.name, size: file.size, type: file.type };
    }

    let state;
    try {
      state = repository.update((draft) => {
        const sequence = Number(draft.normSequenceByYear?.[year] || 0) + 1;
        draft.normSequenceByYear ||= {};
        draft.normSequenceByYear[year] = sequence;
        norm.number = `SOKOL-${year}-${String(sequence).padStart(3, "0")}`;
        draft.norms.push(norm);
      });
    } catch (error) {
      await fileRepository.removeFile(norm.file?.id);
      throw error;
    }
    const createdNorm = findNorm(state, norm.id);
    recordManagement(actor.id, "norm.created", norm.id, { number: createdNorm.number });
    return { norm: createdNorm, message: `Norma ${createdNorm.number} byla založena.` };
  }

  async function update(sessionId, normId, patch = {}) {
    const { actor, norm: current } = managedNorm(sessionId, normId, "norm.update");
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([key]) => UPDATE_FIELDS.has(key)),
    );
    if (CLOSED_STATUSES.has(changes.status ?? current.status)) {
      changes.commentsOpen = false;
    }
    const nextCommentsOpen = changes.commentsOpen ?? current.commentsOpen;
    if (current.commentsOpen && !nextCommentsOpen) {
      const closureReason = normalizeText(changes.closureReason ?? current.closureReason);
      if (!closureReason) throw new NormServiceError("CLOSURE_REASON_REQUIRED");
      changes.closureReason = closureReason;
    } else if (!current.commentsOpen && nextCommentsOpen) {
      changes.closureReason = "";
    }
    const state = repository.update((draft) => {
      Object.assign(findNorm(draft, normId), changes);
    });
    const norm = findNorm(state, normId);
    recordManagement(actor.id, "norm.updated", normId, { fields: Object.keys(changes) });
    return { norm, message: "Změny normy byly uloženy." };
  }

  async function remove(sessionId, normId) {
    const { actor, norm } = managedNorm(sessionId, normId, "norm.remove");
    repository.update((draft) => {
      draft.norms = draft.norms.filter((candidate) => candidate.id !== normId);
      draft.votes = Object.fromEntries(
        Object.entries(draft.votes).filter(([key]) => key.split(":")[2] !== normId),
      );
    });
    recordManagement(actor.id, "norm.deleted", normId, { number: norm.number });
    try {
      await fileRepository.removeFile(norm.file?.id);
    } catch {
      // The repository commit and its audit are authoritative; old file cleanup is best-effort.
    }
    return { normId, message: "Norma byla smazána." };
  }

  async function replaceDocument(sessionId, normId, file) {
    const { actor, norm } = managedNorm(sessionId, normId, "norm.replace_document");
    if (!file || !normalizeText(file.name)) throw new NormServiceError("INVALID_FILE");
    if (file.size > MAX_FILE_SIZE) throw new NormServiceError("FILE_TOO_LARGE");
    const fileId = uniqueId(`file-${normId}`);
    const descriptor = { id: fileId, name: file.name, size: file.size, type: file.type };

    await fileRepository.storeFile(fileId, file);
    try {
      repository.update((draft) => {
        findNorm(draft, normId).file = descriptor;
      });
    } catch (error) {
      try {
        await fileRepository.removeFile(fileId);
      } catch {
        // Preserve the repository error; removal of an uncommitted file is best-effort.
      }
      throw error;
    }
    recordManagement(actor.id, "norm.document_replaced", normId, {
      oldFileId: norm.file?.id || null,
      newFileId: fileId,
    });
    try {
      await fileRepository.removeFile(norm.file?.id);
    } catch {
      // The new descriptor and audit are committed; obsolete file cleanup is best-effort.
    }
    return { file: descriptor, message: "Dokument byl bezpečně uložen pro pilotní test." };
  }

  async function addContribution(sessionId, normId, input) {
    const actor = participatingActor(sessionId, "norm.add_contribution", normId);
    const state = repository.read();
    const norm = findNorm(state, normId);
    assertParticipationOpen(norm);
    const title = normalizeText(input?.title);
    const text = normalizeText(input?.text);
    if (!title || !text) throw new NormServiceError("INVALID_CONTRIBUTION");
    const timestamp = now();
    const contribution = {
      id: `submission-${timestamp}-${norm.submissions.length + 1}`,
      kind: input?.kind === "Návrh úpravy" ? "Návrh úpravy" : "Komentář",
      section: normalizeText(input?.section) || "Obecně",
      title,
      text,
      authorUserId: actor.id,
      author: displayName(actor),
      unit: normalizeText(actor.sokolUnit),
      createdAt: new Date(timestamp).toISOString().slice(0, 10),
      score: 0,
      resolutionStatus: "Nevypořádáno",
      resolution: "",
      adminComment: "",
      replies: [],
    };
    repository.update((draft) => {
      findNorm(draft, normId).submissions.push(contribution);
    });
    return { contribution, message: `${contribution.kind} byl zveřejněn.` };
  }

  async function reply(sessionId, normId, submissionId, text) {
    const { actor, norm } = managedNorm(sessionId, normId, "norm.reply");
    const replyText = normalizeText(text);
    if (!replyText) throw new NormServiceError("INVALID_CONTRIBUTION");
    const reply = {
      id: uniqueId(`reply-${submissionId}`),
      authorUserId: actor.id,
      author: displayName(actor),
      unit: normalizeText(actor.sokolUnit),
      text: replyText,
    };
    repository.update((draft) => {
      findSubmission(findNorm(draft, normId), submissionId).replies.push(reply);
    });
    recordManagement(actor.id, "norm.reply_added", normId, { submissionId, replyId: reply.id });
    return { reply, message: "Odpověď byla přidána." };
  }

  async function voteSubmission(sessionId, normId, submissionId, direction) {
    const actor = participatingActor(sessionId, "norm.vote_submission", normId);
    if (![1, -1].includes(direction)) throw new NormServiceError("INVALID_VOTE");
    assertParticipationOpen(findNorm(repository.read(), normId));
    const key = `submission:${actor.id}:${normId}:${submissionId}`;
    const state = repository.update((draft) => {
      const submission = findSubmission(findNorm(draft, normId), submissionId);
      const previous = Number(draft.votes[key] || 0);
      submission.score = Number(submission.score || 0) - previous + direction;
      draft.votes[key] = direction;
    });
    return {
      vote: direction,
      score: findSubmission(findNorm(state, normId), submissionId).score,
      message: "Hlas u podnětu byl uložen.",
    };
  }

  async function voteNeed(sessionId, normId, value) {
    const actor = participatingActor(sessionId, "norm.vote_need", normId);
    if (!["yes", "no"].includes(value)) throw new NormServiceError("INVALID_VOTE");
    assertParticipationOpen(findNorm(repository.read(), normId));
    const key = `need:${actor.id}:${normId}`;
    const state = repository.update((draft) => {
      const norm = findNorm(draft, normId);
      const previous = draft.votes[key];
      if (previous && previous !== value) {
        norm.needVotes[previous] = Math.max(0, Number(norm.needVotes[previous] || 0) - 1);
      }
      if (previous !== value) {
        norm.needVotes[value] = Number(norm.needVotes[value] || 0) + 1;
      }
      draft.votes[key] = value;
    });
    return {
      vote: value,
      needVotes: findNorm(state, normId).needVotes,
      message: "Hlas o potřebnosti normy byl uložen.",
    };
  }

  async function resolveSubmission(sessionId, normId, submissionId, resolution) {
    const { actor, norm } = managedNorm(sessionId, normId, "norm.resolve_submission");
    const resolutionStatus = normalizeText(resolution?.resolutionStatus);
    if (!RESOLUTION_STATUSES.has(resolutionStatus)) {
      throw new NormServiceError("INVALID_RESOLUTION");
    }
    const resolutionReason = normalizeText(resolution?.resolution);
    if (!resolutionReason) throw new NormServiceError("RESOLUTION_REASON_REQUIRED");
    const state = repository.update((draft) => {
      Object.assign(findSubmission(findNorm(draft, normId), submissionId), {
        resolutionStatus,
        resolution: resolutionReason,
        adminComment: normalizeText(resolution?.adminComment),
      });
    });
    recordManagement(actor.id, "norm.submission_resolved", normId, {
      submissionId,
      resolutionStatus,
    });
    return {
      submission: findSubmission(findNorm(state, normId), submissionId),
      message: "Vypořádání bylo uloženo a je viditelné členům.",
    };
  }

  return {
    listPublicNorms,
    getPublicNorm,
    listManageable,
    create,
    update,
    remove,
    replaceDocument,
    addContribution,
    reply,
    voteSubmission,
    voteNeed,
    resolveSubmission,
  };
}
