import type { NextFunction, Request, Response } from "express";
import { authClient } from "./supabase.js";
import { unauthorized } from "./errors.js";
import { prisma } from "./prisma.js";
import type { UserRole } from "../types/database.types.js";

/**
 * Verifies the caller's Supabase access token (Authorization: Bearer <token>)
 * and attaches { id, role } to req.user. Role comes from `profiles`, looked
 * up with the service-role client — the token itself only proves identity,
 * not role, so every request pays one extra lookup for that.
 *
 * Uses getClaims() rather than getUser(): getUser() always calls out to the
 * Supabase Auth server over the network for every single request. getClaims()
 * verifies the JWT locally against a cached JWKS (near-instant) when the
 * project uses asymmetric signing keys, and only falls back to a network
 * call otherwise — strictly faster or equal, never slower. This was costing
 * every authenticated request 1-3+ seconds of pure network latency; the
 * agent-workspace demo chains ~11 sequential requests per run, which is why
 * it looked "stuck" rather than merely slow.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) throw unauthorized("Missing bearer token");

    const { data, error } = await authClient.auth.getClaims(token);
    if (error || !data?.claims?.sub) throw unauthorized("Invalid or expired token");
    const userId = data.claims.sub;

    const profile = await prisma.profiles.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!profile) throw unauthorized("No profile for this user");

    req.user = { id: userId, role: profile.role as UserRole };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * `staff` accepts admin and agent interchangeably (confirmed: no role split
 * between them for this migration). `customer` requires exactly that role.
 */
export function requireRole(kind: "staff" | "customer") {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    const ok =
      kind === "staff"
        ? req.user.role === "admin" || req.user.role === "agent"
        : req.user.role === "customer";
    if (!ok) return next(unauthorized(`Requires ${kind} role`));
    next();
  };
}
