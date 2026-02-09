/**
 * tezit-relay database schema
 *
 * Core tables for persisting and delivering context-rich messages (Tez).
 * Deliberately minimal — no billing, no onboarding, no AI runtime tables.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// ─────────────────────────────────────────────────────────────────────────────
// TEAMS — who can communicate
// ─────────────────────────────────────────────────────────────────────────────

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(), // UUID
  name: text("name").notNull(),
  createdBy: text("created_by").notNull(), // userId of creator
  createdAt: text("created_at").notNull(), // ISO8601
  updatedAt: text("updated_at").notNull(),
});

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // "admin" | "member"
    joinedAt: text("joined_at").notNull(),
  },
  (table) => [
    index("idx_tm_team").on(table.teamId),
    index("idx_tm_user").on(table.userId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// TEZ — the message (surface layer)
// ─────────────────────────────────────────────────────────────────────────────

export const tez = sqliteTable(
  "tez",
  {
    id: text("id").primaryKey(), // UUID
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    threadId: text("thread_id"), // null = root of new thread, else references tez.id
    parentTezId: text("parent_tez_id"), // direct reply-to (for threading)

    // Surface — what the recipient sees first
    surfaceText: text("surface_text").notNull(),
    type: text("type").notNull().default("note"), // note | decision | handoff | question | update
    urgency: text("urgency").notNull().default("normal"), // critical | high | normal | low | fyi
    actionRequested: text("action_requested"), // what you want them to do

    // Origin
    senderUserId: text("sender_user_id").notNull(),
    visibility: text("visibility").notNull().default("team"), // team | dm | private

    // State
    status: text("status").notNull().default("active"), // active | archived | deleted
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_tez_team").on(table.teamId),
    index("idx_tez_thread").on(table.threadId),
    index("idx_tez_sender").on(table.senderUserId),
    index("idx_tez_created").on(table.createdAt),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// TEZ CONTEXT — the iceberg beneath the surface
// ─────────────────────────────────────────────────────────────────────────────

export const tezContext = sqliteTable(
  "tez_context",
  {
    id: text("id").primaryKey(), // UUID
    tezId: text("tez_id")
      .notNull()
      .references(() => tez.id),

    // What kind of context is this?
    layer: text("layer").notNull(),
    // "background"    — why this matters, how we got here
    // "fact"          — structured claim with confidence
    // "artifact"      — original evidence (voice, doc, etc.)
    // "relationship"  — connection to entity
    // "constraint"    — boundary or limitation
    // "hint"          — proactive suggestion for recipient

    content: text("content").notNull(), // the actual content (text or JSON)
    mimeType: text("mime_type"), // for binary artifacts
    confidence: integer("confidence"), // 0-100 for facts
    source: text("source"), // "stated" | "inferred" | "verified"
    derivedFrom: text("derived_from"), // id of context this was derived from

    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(), // userId or "system"
  },
  (table) => [index("idx_ctx_tez").on(table.tezId)]
);

// ─────────────────────────────────────────────────────────────────────────────
// RECIPIENTS — who should receive each Tez
// ─────────────────────────────────────────────────────────────────────────────

export const tezRecipients = sqliteTable(
  "tez_recipients",
  {
    tezId: text("tez_id")
      .notNull()
      .references(() => tez.id),
    userId: text("user_id").notNull(),
    deliveredAt: text("delivered_at"),
    readAt: text("read_at"),
    acknowledgedAt: text("acknowledged_at"),
  },
  (table) => [
    index("idx_recip_tez").on(table.tezId),
    index("idx_recip_user").on(table.userId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG — append-only, every mutation recorded
// ─────────────────────────────────────────────────────────────────────────────

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(), // UUID
    teamId: text("team_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    // "tez.shared" | "tez.replied" | "tez.read" | "tez.acknowledged"
    // "tez.archived" | "tez.deleted"
    // "team.created" | "team.member_added" | "team.member_removed"
    targetType: text("target_type").notNull(), // "tez" | "team"
    targetId: text("target_id").notNull(),
    metadata: text("metadata", { mode: "json" }), // extra context (JSON)
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_audit_team").on(table.teamId),
    index("idx_audit_actor").on(table.actorUserId),
    index("idx_audit_target").on(table.targetType, table.targetId),
    index("idx_audit_time").on(table.createdAt),
  ]
);
