import { cookies } from "next/headers";
import { verifySessionToken, type SessionPayload } from "./auth";

export const SESSION_COOKIE = "wp_session";

export async function getSessionUser(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Please sign in first." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export function forbidden(message = "Not allowed."): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

export function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
