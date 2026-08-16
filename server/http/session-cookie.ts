export const sessionCookieOptions = {
  name: "__Host-sokol_session",
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

interface CookieWriter {
  set(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: "lax";
      path: string;
      expires?: Date;
      maxAge?: number;
    },
  ): void;
}

const { name, ...cookieAttributes } = sessionCookieOptions;

export function setSessionCookie(
  cookies: CookieWriter,
  token: string,
  expires: Date,
): void {
  cookies.set(name, token, { ...cookieAttributes, expires });
}

export function clearSessionCookie(cookies: CookieWriter): void {
  cookies.set(name, "", { ...cookieAttributes, maxAge: 0 });
}
