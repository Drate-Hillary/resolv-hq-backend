import { Prisma } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { requireRole } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { formatMemberSince, initialsFromName } from "../lib/mappers.js";
import { isNotFound } from "../lib/prisma-errors.js";
import { prisma } from "../lib/prisma.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { UserProfile } from "../types/api.js";
import type { CustomerProfile, Profile } from "../types/database.types.js";

const router = Router();

router.get(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const profile = (await prisma.profiles.findUnique({ where: { id: userId } })) as unknown as Profile | null;
    if (!profile) throw notFound("Profile not found");

    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = authUser?.user?.email ?? profile.email ?? "";
    const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");

    let customerProfile: CustomerProfile | null = null;
    if (profile.role === "customer") {
      customerProfile = (await prisma.customer_profiles.findUnique({
        where: { user_id: userId },
      })) as unknown as CustomerProfile | null;
    }

    const body: UserProfile = {
      id: userId,
      role: profile.role,
      name: fullName,
      email,
      phone: profile.phone ?? "",
      memberSince: formatMemberSince(profile.created_at),
      avatarInitials: initialsFromName(fullName || email || "?"),
      organizationName: customerProfile?.organization_name ?? "",
      city: customerProfile?.city ?? "",
      country: customerProfile?.country ?? "Uganda",
      preferredLanguage: customerProfile?.preferred_language ?? "English",
    };
    res.json(body);
  }),
);

/**
 * `id` is always `req.user.id`, never a client-supplied id.
 */
router.patch(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { name, phone, email } = req.body as { name?: string; phone?: string; email?: string };

    const profilePatch: Prisma.profilesUpdateInput = {};
    if (name !== undefined) {
      const [firstName, ...rest] = name.trim().split(/\s+/);
      profilePatch.first_name = firstName || name;
      profilePatch.last_name = rest.length > 0 ? rest.join(" ") : null;
    }
    if (phone !== undefined) profilePatch.phone = phone;
    if (Object.keys(profilePatch).length > 0) {
      await prisma.profiles.updateMany({ where: { id: userId }, data: profilePatch });
    }

    // Service-role client updates auth directly — there's no session to call
    // auth.updateUser() against, unlike the source app's client-side flow.
    if (email !== undefined) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { email });
      if (error) throw error;
      await prisma.profiles.updateMany({ where: { id: userId }, data: { email } });
    }

    res.json({
      ...(name !== undefined ? { name } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(email !== undefined ? { email } : {}),
    });
  }),
);

router.patch(
  "/preferences",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { organizationName, city, country, preferredLanguage } = req.body as Partial<{
      organizationName: string;
      city: string;
      country: string;
      preferredLanguage: string;
    }>;

    const patch: Prisma.customer_profilesUpdateInput = {};
    if (organizationName !== undefined) patch.organization_name = organizationName;
    if (city !== undefined) patch.city = city;
    if (country !== undefined) patch.country = country;
    if (preferredLanguage !== undefined) patch.preferred_language = preferredLanguage;
    if (Object.keys(patch).length === 0) throw badRequest("No preference fields provided");

    let data: CustomerProfile;
    try {
      data = (await prisma.customer_profiles.update({
        where: { user_id: userId },
        data: patch,
      })) as unknown as CustomerProfile;
    } catch (err) {
      if (isNotFound(err)) throw notFound("Customer profile not found");
      throw err;
    }

    res.json({
      organizationName: data.organization_name ?? "",
      city: data.city ?? "",
      country: data.country,
      preferredLanguage: data.preferred_language,
    });
  }),
);

export default router;
