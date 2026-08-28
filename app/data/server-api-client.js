const STATUS_LABELS = {
  concept: "Koncept",
  file_check: "Kontrola souboru",
  conversion: "Převod dokumentu",
  conversion_review: "Kontrola převodu",
  ready: "Připraveno ke zveřejnění",
  published_open: "K připomínkování",
  comments_closed: "Připomínky uzavřeny",
  settlement: "Vypořádání",
  settled: "Ke schválení",
  approved: "Schváleno",
  rejected: "Neschváleno",
  archived: "Archivováno",
};

const SERVER_STATUS = {
  Koncept: "concept",
  "Připraveno ke zveřejnění": "ready",
  "K připomínkování": "published_open",
  "Připomínky uzavřeny": "comments_closed",
  Vypořádání: "settlement",
  "Ke schválení": "settled",
  Schváleno: "approved",
  Neschváleno: "rejected",
  Archivováno: "archived",
};

function adaptViewer(viewer) {
  if (!viewer) return null;
  return {
    ...viewer,
    sokolUnit: viewer.organizationName,
    status: "active",
  };
}

function adaptDocument(document) {
  return {
    ...document,
    id: document.id || document.publicId,
    number: document.publicId,
    status: STATUS_LABELS[document.status] || document.status,
    serverStatus: document.status,
    reason: document.explanatoryReport,
    summary: document.explanatoryReport,
    responsible: document.responsibleAdminName,
    submittedBy: document.responsibleAdminName,
    category: "Norma",
    version: "",
    deadline: "",
    publishedAt: document.createdAt?.slice(0, 10) || "",
    visibilityMode:
      document.visibilityMode === "login_required_detail" ? "title-only" : "public-detail",
    content: [],
    sections: [],
    submissions: [],
    needVotes: { yes: 0, no: 0 },
    file: null,
    latestReadyVersionId: document.latestReadyVersionId || null,
  };
}

function resolutionLabel(settlement) {
  if (!settlement) return "Nevypořádáno";
  if (["accepted", "partially_accepted"].includes(settlement.outcome)) return "Zapracováno";
  return "Nezapracováno";
}

function adaptPublicDetail(document) {
  const comments = (document.threads || []).flatMap((thread) => thread.comments || []);
  const roots = comments.filter((comment) => !comment.parentPublicId);
  return {
    ...adaptDocument(document),
    id: document.publicId,
    number: document.publicId,
    version: document.version ? String(document.version.versionNumber) : "",
    publishedAt: document.version?.publishedAt?.slice(0, 10) || document.createdAt?.slice(0, 10) || "",
    content: document.version?.blocks || [],
    file: document.version?.originalName
      ? { name: document.version.originalName, publicId: document.publicId }
      : null,
    participationVersion: document.participationVersion,
    needVotes: document.needVotes,
    submissions: roots.map((comment) => ({
      id: comment.publicId,
      blockUid: comment.blockUid,
      rowVersion: comment.rowVersion,
      kind: comment.type === "proposal" ? "Návrh úpravy" : comment.type === "question" ? "Dotaz" : "Komentář",
      section: `Blok ${(document.version?.blocks || []).findIndex((block) => block.blockUid === comment.blockUid) + 1}`,
      title: comment.text.split(/\r?\n/)[0],
      text: comment.text,
      author: comment.authorName,
      unit: comment.organizationName,
      createdAt: comment.createdAt.slice(0, 10),
      score: comment.score,
      currentUserVote: comment.currentUserVote,
      resolutionStatus: resolutionLabel(comment.settlement),
      resolution: comment.settlement?.statement || "",
      adminComment: "",
      replies: comments.filter((reply) => reply.parentPublicId === comment.publicId).map((reply) => ({
        id: reply.publicId,
        author: reply.authorName,
        text: reply.text,
        createdAt: reply.createdAt.slice(0, 10),
      })),
    })),
  };
}

export function adaptBootstrapForPilotUi(snapshot) {
  const allByPublicId = new Map(snapshot.documents.map((item) => [item.publicId, item]));
  for (const managed of snapshot.managedDocuments) {
    allByPublicId.set(managed.publicId, {
      ...allByPublicId.get(managed.publicId),
      ...managed,
    });
  }
  return {
    viewer: adaptViewer(snapshot.viewer),
    organizations: snapshot.organizations,
    capabilities: snapshot.capabilities,
    norms: [...allByPublicId.values()].map(adaptDocument),
    managedNorms: snapshot.managedDocuments.map(adaptDocument),
  };
}

export function createServerApiClient({
  fetchImpl = globalThis.fetch,
  csrfToken,
} = {}) {
  let currentCsrfToken = "";
  let currentSnapshot = {
    viewer: null,
    organizations: [],
    capabilities: { manageUsers: false, createDocument: false },
    norms: [],
    managedNorms: [],
  };
  let cachedUsers = [];

  const readCsrf = csrfToken || (() => currentCsrfToken);

  async function request(path, {
    method = "GET",
    body,
    rawBody,
    headers: suppliedHeaders,
    rowVersion,
    idempotencyKey,
    csrf = method !== "GET",
  } = {}) {
    const headers = { ...suppliedHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (rowVersion !== undefined) headers["if-match"] = String(rowVersion);
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (csrf && readCsrf()) headers["x-csrf-token"] = readCsrf();
    const response = await fetchImpl(path, {
      method,
      credentials: "same-origin",
      headers,
      ...(rawBody !== undefined
        ? { body: rawBody }
        : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const isJson = response.headers.get("content-type")?.includes("json");
    const payload = isJson ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(payload?.detail || "Operaci se nepodařilo dokončit.");
      error.code = payload?.code || "REQUEST_FAILED";
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function bootstrap() {
    currentSnapshot = adaptBootstrapForPilotUi(await request("/api/bootstrap"));
    if (currentSnapshot.viewer && !currentCsrfToken) {
      const result = await request("/api/auth/session/csrf", {
        method: "POST",
        csrf: false,
      });
      currentCsrfToken = result.csrfToken;
    }
    return currentSnapshot;
  }

  async function createPublicOriginalDownloadLink(publicId) {
    return request(`/api/public/documents/${encodeURIComponent(publicId)}/original-download-link`);
  }

  const uploadDocumentVersion = (documentId, file, command) => request(
    `/api/documents/${documentId}/versions/uploads`,
    {
      method: "POST",
      rawBody: file,
      rowVersion: command.rowVersion,
      idempotencyKey: command.idempotencyKey,
      headers: {
        "content-type": file.type,
        "content-length": String(file.size),
        "x-file-name": encodeURIComponent(file.name),
      },
    },
  );

  const getConversionProcessing = (versionId) =>
    request(`/api/document-versions/${versionId}/processing`);
  const getConversionPreview = (versionId) =>
    request(`/api/document-versions/${versionId}/preview`);
  const retryConversion = (jobId, command) => request(`/api/conversion-jobs/${jobId}/retry`, {
    method: "POST",
    body: {},
    rowVersion: command.rowVersion,
    idempotencyKey: command.idempotencyKey,
  });
  const updateBlockStructure = (versionId, blockUid, input) => request(
    `/api/document-versions/${versionId}/blocks/${blockUid}`,
    {
      method: "PATCH",
      body: {
        reason: input.reason,
        type: input.type,
        text: input.text,
        commentable: input.commentable,
        ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.sourceRange === undefined ? {} : { sourceRange: input.sourceRange }),
        ...(input.tableRepresentation === undefined
          ? {} : { tableRepresentation: input.tableRepresentation }),
        ...(input.alternativeText === undefined ? {} : { alternativeText: input.alternativeText }),
      },
      rowVersion: input.rowVersion,
      idempotencyKey: input.idempotencyKey,
    },
  );
  const decideConversionFinding = (findingId, input) => request(
    `/api/conversion-findings/${findingId}/decision`,
    {
      method: "POST",
      body: { status: input.status, reason: input.reason },
      rowVersion: input.rowVersion,
      idempotencyKey: input.idempotencyKey,
    },
  );
  const completeConversionReview = (versionId, command) => request(
    `/api/document-versions/${versionId}/review-completion`,
    {
      method: "POST",
      body: {},
      rowVersion: command.rowVersion,
      idempotencyKey: command.idempotencyKey,
    },
  );
  const createFileDownloadLink = (fileId) =>
    request(`/api/file-objects/${fileId}/download-link`);
  const generateVersionMappings = (versionId, command) => request(
    `/api/document-versions/${versionId}/mappings`,
    {
      method: "POST",
      idempotencyKey: command.idempotencyKey,
    },
  );
  const getVersionMappings = (versionId) =>
    request(`/api/document-versions/${versionId}/mappings`);
  const decideVersionMapping = (mappingId, input) => request(
    `/api/block-mappings/${mappingId}/decision`,
    {
      method: "PUT",
      body: { decision: input.decision, reason: input.reason },
      rowVersion: input.rowVersion,
      idempotencyKey: input.idempotencyKey,
    },
  );
  const createPdfExport = (documentId, input) => request(
    `/api/documents/${documentId}/exports`,
    {
      method: "POST",
      body: {
        documentVersionId: input.documentVersionId,
        visibility: input.visibility,
        filters: input.filters,
        options: input.options,
      },
      idempotencyKey: input.idempotencyKey,
    },
  );
  const getPdfExport = (jobId) => request(`/api/export-jobs/${jobId}`);
  const getPdfExportDownloadLink = (jobId) =>
    request(`/api/export-jobs/${jobId}/download-link`);
  const createXlsxExport = (documentId, documentVersionId) => request(`/api/documents/${documentId}/xlsx-exports`, {
    method: "POST", body: { documentVersionId }, idempotencyKey: crypto.randomUUID(),
  });
  const getXlsxExport = (jobId) => request(`/api/xlsx-exports/${jobId}`);
  const getXlsxExportDownloadLink = (jobId) => request(`/api/xlsx-exports/${jobId}/download-link`);
  const uploadXlsxImport = async (documentId, file, exportJobId) => {
    const form = new FormData(); form.set("file", file);
    const response = await fetchImpl(`/api/documents/${documentId}/xlsx-imports?exportJobId=${encodeURIComponent(exportJobId || "")}`, {
      method: "POST", credentials: "same-origin", body: form,
      headers: { "idempotency-key": crypto.randomUUID(), ...(readCsrf() ? { "x-csrf-token": readCsrf() } : {}) },
    });
    const payload = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    if (!response.ok) throw Object.assign(new Error(payload?.detail || "Import se nepodařilo dokončit."), { code: payload?.code, status: response.status });
    return payload;
  };
  const getXlsxImport = (batchId) => request(`/api/xlsx-imports/${batchId}`);
  const getXlsxImportRows = (batchId, classification = "conflict", offset = 0) => request(
    `/api/xlsx-imports/${batchId}/rows?classification=${encodeURIComponent(classification)}&limit=100&offset=${offset}`,
  );
  const applySafeXlsxImport = (batchId, rowVersion) => request(
    `/api/xlsx-imports/${batchId}/apply-safe`, {
      method: "POST", body: {}, rowVersion, idempotencyKey: crypto.randomUUID(),
    },
  );
  const decideXlsxConflict = (batchId, rowId, decision, rowVersion, reason) => request(
    `/api/xlsx-imports/${batchId}/decisions`, {
      method: "POST", body: { rowId, decision, reason }, rowVersion,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const applyXlsxConflicts = (batchId, rowVersion) => request(
    `/api/xlsx-imports/${batchId}/apply-conflicts`, {
      method: "POST", body: {}, rowVersion, idempotencyKey: crypto.randomUUID(),
    },
  );
  const cancelXlsxImport = (batchId, rowVersion) => request(
    `/api/xlsx-imports/${batchId}/cancel`, {
      method: "POST", body: {}, rowVersion, idempotencyKey: crypto.randomUUID(),
    },
  );
  const retryXlsxImport = (batchId, rowVersion) => request(
    `/api/xlsx-imports/${batchId}/retry`, {
      method: "POST", body: {}, rowVersion, idempotencyKey: crypto.randomUUID(),
    },
  );

  const auth = {
    backend: "server",
    ensureDemoCredentials: async () => undefined,
    identify: () => ({ kind: "method-choice" }),
    requestMemberCode: async (email) => request("/api/auth/member/request-code", {
      method: "POST",
      csrf: false,
      body: { email },
    }),
    registerMember: async (input) => {
      const organization = currentSnapshot.organizations.find(
        (candidate) => candidate.code === input.sokolUnit || candidate.name === input.sokolUnit,
      );
      return request("/api/auth/member/request-code", {
        method: "POST",
        csrf: false,
        body: {
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          organizationCode: organization?.code || input.sokolUnit,
          membershipId: input.membershipId || null,
        },
      });
    },
    verifyMemberCode: async ({ challengeId, code }) => {
      const result = await request("/api/auth/member/verify-code", {
        method: "POST",
        csrf: false,
        body: { challengeId, code },
      });
      currentCsrfToken = result.csrfToken;
      return { id: "server-cookie", user: adaptViewer(result.user) };
    },
    loginWithPassword: async ({ email, password }) => {
      const result = await request("/api/auth/admin/password", {
        method: "POST",
        csrf: false,
        body: { email, password },
      });
      if (result.kind === "mfa_required") return result;
      currentCsrfToken = result.csrfToken;
      return { id: "server-cookie", user: adaptViewer(result.user) };
    },
    verifyAdminMfa: async ({ loginAttemptId, token }) => {
      const result = await request("/api/auth/admin/mfa", {
        method: "POST",
        csrf: false,
        body: { loginAttemptId, token },
      });
      currentCsrfToken = result.csrfToken;
      return { id: "server-cookie", user: adaptViewer(result.user) };
    },
    requestPasswordReset: async (email) => request("/api/auth/admin/reset/request", {
      method: "POST",
      csrf: false,
      body: { email },
    }),
    completePasswordReset: async ({ token, password }) => request(
      "/api/auth/admin/reset/complete",
      { method: "POST", csrf: false, body: { token, password } },
    ),
    completePasswordSetup: async ({ token, password }) => request("/api/auth/admin/setup", {
      method: "POST",
      csrf: false,
      body: { token, password },
    }),
    logout: async () => {
      await request("/api/auth/logout", { method: "POST" });
      currentCsrfToken = "";
    },
  };

  const normService = {
    async loadDetail(publicId) {
      const result = await request(`/api/public/documents/${encodeURIComponent(publicId)}`);
      return adaptPublicDetail(result.document);
    },
    listPublicNorms(filter = "Všechny") {
      const closed = new Set(["Schváleno", "Neschváleno", "Archivováno"]);
      const active = new Set(["K připomínkování", "Vypořádání", "Ke schválení"]);
      return currentSnapshot.norms.filter((norm) =>
        filter === "Všechny" || (filter === "Uzavřené" ? closed.has(norm.status) : active.has(norm.status)),
      );
    },
    listManageable() {
      return currentSnapshot.managedNorms;
    },
    async update(_sessionId, documentId, patch) {
      const current = currentSnapshot.managedNorms.find((item) => item.id === documentId) || {};
      const result = await request(`/api/documents/${documentId}`, {
        method: "PATCH",
        rowVersion: patch.rowVersion ?? current.rowVersion,
        idempotencyKey: patch.idempotencyKey,
        body: {
          title: patch.title ?? current.title ?? "",
          explanatoryReport: patch.explanatoryReport ?? patch.reason ?? current.explanatoryReport ?? "",
          visibilityMode:
            (patch.visibilityMode ?? current.visibilityMode) === "title-only"
              ? "login_required_detail"
              : "public_detail",
          fourEyesRequired: patch.fourEyesRequired ?? current.fourEyesRequired ?? false,
        },
      });
      const requestedStatus = SERVER_STATUS[patch.status];
      if (requestedStatus && requestedStatus !== result.document.status) {
        const transitioned = await request(`/api/documents/${documentId}/status`, {
          method: "POST",
          rowVersion: result.document.rowVersion,
          idempotencyKey: crypto.randomUUID(),
          body: { status: requestedStatus, reason: patch.closureReason || "" },
        });
        return { norm: adaptDocument(transitioned.document), message: "Norma a její stav byly aktualizovány." };
      }
      return { norm: adaptDocument(result.document), message: "Norma byla aktualizována." };
    },
    async create(_sessionId, input, file) {
      const result = await request("/api/documents", {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        body: {
          title: input.title,
          explanatoryReport: input.reason || input.summary || "",
          visibilityMode: "public_detail",
          fourEyesRequired: false,
        },
      });
      const norm = adaptDocument(result.document);
      if (!file) return { norm, message: "Norma byla založena." };
      const upload = await uploadDocumentVersion(norm.id, file, {
        rowVersion: norm.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      });
      return {
        norm,
        upload,
        message: "Norma byla založena a dokument byl zařazen ke zpracování.",
      };
    },
    async changeStatus(_sessionId, documentId, status, reason, rowVersion) {
      const result = await request(`/api/documents/${documentId}/status`, {
        method: "POST",
        rowVersion,
        idempotencyKey: crypto.randomUUID(),
        body: { status: SERVER_STATUS[status] || status, reason: reason || "" },
      });
      return { norm: adaptDocument(result.document) };
    },
    replaceDocument: async () => { throw new Error("Nahrání DOCX bude zapnuto v následující etapě."); },
    remove: async () => { throw new Error("Mazání dokumentů není v produkčním workflow povoleno."); },
    async addContribution(_sessionId, publicId, input) {
      return request(`/api/public/documents/${encodeURIComponent(publicId)}/blocks/${input.blockUid}/comments`, {
        method: "POST",
        rowVersion: input.participationVersion,
        idempotencyKey: crypto.randomUUID(),
        body: {
          type: input.kind === "Návrh úpravy" ? "proposal" : "comment",
          text: input.text,
          priority: input.priority || "normal",
        },
      });
    },
    async reply(_sessionId, _publicId, commentPublicId, text, participationVersion) {
      return request(`/api/public/comments/${commentPublicId}/replies`, {
        method: "POST", rowVersion: participationVersion, idempotencyKey: crypto.randomUUID(),
        body: { text },
      });
    },
    async voteSubmission(_sessionId, _publicId, commentPublicId, direction, commentRowVersion, participationVersion) {
      return request(`/api/public/comments/${commentPublicId}/vote`, {
        method: "PUT", rowVersion: participationVersion, idempotencyKey: crypto.randomUUID(),
        body: { value: direction, commentRowVersion },
      });
    },
    async voteNeed(_sessionId, publicId, value, participationVersion) {
      return request(`/api/public/documents/${encodeURIComponent(publicId)}/need-vote`, {
        method: "PUT", rowVersion: participationVersion, idempotencyKey: crypto.randomUUID(),
        body: { value },
      });
    },
    resolveSubmission: async () => { throw new Error("Vypořádání bude zapnuto v následující etapě."); },
  };

  const userService = {
    async loadUsers(filters = {}) {
      const query = new URLSearchParams();
      if (filters.query) query.set("search", filters.query);
      if (filters.role) query.set("role", filters.role);
      if (filters.status) query.set("status", filters.status);
      const result = await request(`/api/users${query.size ? `?${query}` : ""}`);
      cachedUsers = result.users.map((user) => ({ ...user, sokolUnit: user.organizationName }));
      return cachedUsers;
    },
    listUsers(_sessionId, filters = {}) {
      return cachedUsers.filter((user) =>
        (!filters.query || `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(filters.query.toLowerCase()))
        && (!filters.role || user.role === filters.role)
        && (!filters.status || user.status === filters.status),
      );
    },
    getUser(_sessionId, userId) {
      return cachedUsers.find((user) => user.id === userId) || null;
    },
    async createPrivilegedUser(_sessionId, input) {
      const result = await request("/api/users", {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        body: {
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          organizationCode: input.sokolUnit,
          membershipId: input.membershipId || null,
          role: input.role,
        },
      });
      return { userId: result.user.id };
    },
    async setUserStatus(_sessionId, userId, status) {
      const user = cachedUsers.find((candidate) => candidate.id === userId);
      await request(`/api/users/${userId}/status`, {
        method: "POST",
        rowVersion: user?.rowVersion,
        idempotencyKey: crypto.randomUUID(),
        body: { status },
      });
      return {};
    },
    async changeUserRole(_sessionId, userId, role) {
      const user = cachedUsers.find((candidate) => candidate.id === userId);
      await request(`/api/users/${userId}/role`, {
        method: "POST",
        rowVersion: user?.rowVersion,
        idempotencyKey: crypto.randomUUID(),
        body: { role },
      });
      return {};
    },
  };

  return {
    backend: "server",
    bootstrap,
    uploadDocumentVersion,
    getConversionProcessing,
    getConversionPreview,
    retryConversion,
    updateBlockStructure,
    decideConversionFinding,
    completeConversionReview,
    createFileDownloadLink,
    generateVersionMappings,
    getVersionMappings,
    decideVersionMapping,
    createPdfExport,
    getPdfExport,
    getPdfExportDownloadLink,
    createXlsxExport,
    getXlsxExport,
    getXlsxExportDownloadLink,
    uploadXlsxImport,
    getXlsxImport,
    getXlsxImportRows,
    applySafeXlsxImport,
    decideXlsxConflict,
    applyXlsxConflicts,
    cancelXlsxImport,
    retryXlsxImport,
    createPublicOriginalDownloadLink,
    auth,
    normService,
    userService,
    audit: { listForTarget: () => [] },
  };
}
