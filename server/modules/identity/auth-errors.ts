export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function unauthenticated(): AuthError {
  return new AuthError("UNAUTHENTICATED", "Přihlášení se nepodařilo.", 401);
}
