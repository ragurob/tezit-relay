/**
 * Contact routes — user profile registration and discovery.
 *
 * POST /contacts/register  — Register/update your profile
 * GET  /contacts/me        — Get own profile
 * GET  /contacts/search    — Search contacts by name or email
 * GET  /contacts/:userId   — Get a contact's public profile
 */

import { Router } from "express";
import { z } from "zod";
import { eq, or, like } from "drizzle-orm";
import { db, contacts } from "../db/index.js";
import { authenticate } from "../middleware/auth.js";
import { config } from "../config.js";
import { recordAudit } from "../services/audit.js";

export const contactRoutes = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /contacts/register — Register/update your profile
// ─────────────────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  displayName: z.string().min(1).max(100),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().max(2000).optional(),
});

contactRoutes.post("/register", authenticate, async (req, res) => {
  try {
    const body = RegisterSchema.parse(req.body);
    const userId = req.user!.userId;
    const now = new Date().toISOString();
    const tezAddress = `${userId}@${config.relayHost}`;

    // Check if already registered
    const existing = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, userId))
      .limit(1);

    if (existing.length > 0) {
      // Update existing profile
      await db
        .update(contacts)
        .set({
          displayName: body.displayName,
          email: body.email ?? null,
          avatarUrl: body.avatarUrl ?? null,
          tezAddress,
          updatedAt: now,
        })
        .where(eq(contacts.id, userId));

      const updated = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, userId))
        .limit(1);

      await recordAudit({
        actorUserId: userId,
        action: "contact.updated",
        targetType: "contact",
        targetId: userId,
      });

      res.status(201).json({ data: updated[0] });
      return;
    }

    // Create new profile
    await db.insert(contacts).values({
      id: userId,
      displayName: body.displayName,
      email: body.email ?? null,
      avatarUrl: body.avatarUrl ?? null,
      tezAddress,
      status: "active",
      lastSeenAt: null,
      registeredAt: now,
      updatedAt: now,
    });

    const created = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, userId))
      .limit(1);

    await recordAudit({
      actorUserId: userId,
      action: "contact.registered",
      targetType: "contact",
      targetId: userId,
    });

    res.status(201).json({ data: created[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      return;
    }
    console.error("Register contact error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to register contact" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /contacts/me — Get own profile
// ─────────────────────────────────────────────────────────────────────────────

contactRoutes.get("/me", authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;

    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, userId))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Profile not registered" } });
      return;
    }

    res.json({ data: rows[0] });
  } catch (err) {
    console.error("Get own contact error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to get profile" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /contacts/search — Search contacts by name or email
// ─────────────────────────────────────────────────────────────────────────────

contactRoutes.get("/search", authenticate, async (req, res) => {
  try {
    const q = (req.query.q as string || "").trim();
    if (q.length < 2) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Search query must be at least 2 characters" },
      });
      return;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
    const pattern = `%${q}%`;

    const results = await db
      .select()
      .from(contacts)
      .where(or(like(contacts.displayName, pattern), like(contacts.email, pattern)))
      .limit(limit);

    res.json({ data: results, meta: { count: results.length } });
  } catch (err) {
    console.error("Search contacts error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to search contacts" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /contacts/:userId — Get a contact's public profile
// ─────────────────────────────────────────────────────────────────────────────

contactRoutes.get("/:userId", authenticate, async (req, res) => {
  try {
    const targetUserId = req.params.userId;

    const rows = await db
      .select({
        id: contacts.id,
        displayName: contacts.displayName,
        tezAddress: contacts.tezAddress,
        status: contacts.status,
        lastSeenAt: contacts.lastSeenAt,
      })
      .from(contacts)
      .where(eq(contacts.id, targetUserId))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Contact not found" } });
      return;
    }

    res.json({ data: rows[0] });
  } catch (err) {
    console.error("Get contact error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to get contact" } });
  }
});
