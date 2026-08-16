import { ZodError } from "zod";
import { AuthError } from "../modules/identity/auth-errors";

export function problemResponse(error: unknown, correlationId: string): Response {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let title = "Vnitřní chyba serveru";
  let detail = "Požadavek se nepodařilo dokončit.";

  if (error instanceof ZodError || error instanceof SyntaxError) {
    status = 400;
    code = "INVALID_REQUEST";
    title = "Neplatný požadavek";
    detail = "Odeslaná data nemají očekávaný formát.";
  } else if (error instanceof AuthError) {
    status = error.status;
    code = error.code;
    title = status === 401 ? "Je vyžadováno přihlášení" : "Požadavek nelze dokončit";
    detail = error.message;
  }

  return Response.json(
    {
      type: "about:blank",
      title,
      status,
      detail,
      code,
      correlationId,
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}
