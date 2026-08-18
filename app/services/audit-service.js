const SENSITIVE_METADATA_KEYS = new Set([
  "password",
  "code",
  "token",
  "passwordhash",
  "passwordsalt",
  "sessionid",
]);

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return SENSITIVE_METADATA_KEYS.has(normalized) || normalized.endsWith("token");
}

function sanitizeMetadata(value) {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, nestedValue]) => [key, sanitizeMetadata(nestedValue)]),
  );
}

export function createAuditService(repository, now) {
  function record({ actorUserId, action, targetType, targetId, metadata }) {
    const event = {
      actorUserId,
      action,
      targetType,
      targetId,
      metadata: sanitizeMetadata(metadata),
      createdAt: now(),
    };

    repository.update((state) => {
      state.auditEvents.push(event);
    });

    return event;
  }

  function listForTarget(targetType, targetId) {
    return repository.read().auditEvents.filter(
      (event) => event.targetType === targetType && event.targetId === targetId,
    );
  }

  return { record, listForTarget };
}
