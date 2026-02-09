/**
 * Team ACL service — enforces team membership on every operation.
 *
 * Rule: no query or write crosses team boundaries. Ever.
 */

import { db, teamMembers } from "../db/index.js";
import { eq, and } from "drizzle-orm";

export async function isTeamMember(
  userId: string,
  teamId: string
): Promise<boolean> {
  const rows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);

  return rows.length > 0;
}

export async function isTeamAdmin(
  userId: string,
  teamId: string
): Promise<boolean> {
  const rows = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);

  return rows.length > 0 && rows[0].role === "admin";
}

export async function assertTeamMember(
  userId: string,
  teamId: string
): Promise<void> {
  if (!(await isTeamMember(userId, teamId))) {
    const err = new Error("Not a member of this team");
    (err as NodeJS.ErrnoException).code = "FORBIDDEN";
    throw err;
  }
}
