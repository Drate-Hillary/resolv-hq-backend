import type { NextFunction, Request, Response } from "express";
import { authClient, db } from "./supabase.js";
import { unauthorized } from "./errors.js";

/**
 * Verifies the caller's Supabase access token (Authorization: Bearer <token>)
 * and attaches { id, role } to req.user. Role comes from `profiles`, looked
 * up with the service-role client — the token itself only proves identity,
 * not role, so every request pays one extra lookup for that.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) throw unauthorized("Missing bearer token");

    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) throw unauthorized("Invalid or expired token");

    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .single();
    if (profileError || !profile) throw unauthorized("No profile for this user");

    req.user = { id: data.user.id, role: profile.role };
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
