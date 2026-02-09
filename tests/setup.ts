/**
 * Test setup for tezit-relay integration tests
 *
 * Provides:
 * - In-memory SQLite database matching the production schema
 * - Test Express app wired to the test DB
 * - JWT token generation for test users
 * - Helper to bootstrap a team with an admin user
 */

import { vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../src/db/schema.js";
import { SignJWT } from "jose";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory database
// ─────────────────────────────────────────────────────────────────────────────

let testClient: Client;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

export function getTestClient() {
  return testClient;
}

export function getTestDb() {
  return testDb;
}

/**
 * Initialize in-memory SQLite and create all tables.
 * Must be called in beforeAll().
 */
export async function initTestDb() {
  testClient = createClient({ url: "file::memory:" });

  // Create all tables matching the Drizzle schema
  await testClient.executeMultiple(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id),
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tm_team ON team_members(team_id);
    CREATE INDEX IF NOT EXISTS idx_tm_user ON team_members(user_id);

    CREATE TABLE IF NOT EXISTS tez (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES teams(id),
      conversation_id TEXT,
      thread_id TEXT,
      parent_tez_id TEXT,
      surface_text TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      urgency TEXT NOT NULL DEFAULT 'normal',
      action_requested TEXT,
      sender_user_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'team',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tez_team ON tez(team_id);
    CREATE INDEX IF NOT EXISTS idx_tez_conversation ON tez(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_tez_thread ON tez(thread_id);
    CREATE INDEX IF NOT EXISTS idx_tez_sender ON tez(sender_user_id);
    CREATE INDEX IF NOT EXISTS idx_tez_created ON tez(created_at);

    CREATE TABLE IF NOT EXISTS tez_context (
      id TEXT PRIMARY KEY,
      tez_id TEXT NOT NULL REFERENCES tez(id),
      layer TEXT NOT NULL,
      content TEXT NOT NULL,
      mime_type TEXT,
      confidence INTEGER,
      source TEXT,
      derived_from TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ctx_tez ON tez_context(tez_id);

    CREATE TABLE IF NOT EXISTS tez_recipients (
      tez_id TEXT NOT NULL REFERENCES tez(id),
      user_id TEXT NOT NULL,
      delivered_at TEXT,
      read_at TEXT,
      acknowledged_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recip_tez ON tez_recipients(tez_id);
    CREATE INDEX IF NOT EXISTS idx_recip_user ON tez_recipients(user_id);

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT,
      avatar_url TEXT,
      tez_address TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      last_seen_at TEXT,
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_contacts_tez_address ON contacts(tez_address);

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      last_read_at TEXT,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cm_conv ON conversation_members(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_cm_user ON conversation_members(user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_team ON audit_log(team_id);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
  `);

  testDb = drizzle(testClient, { schema });
  return testDb;
}

/**
 * Clean all rows from all tables (order matters for FK constraints).
 */
export async function cleanDb() {
  await testClient.executeMultiple(`
    DELETE FROM audit_log;
    DELETE FROM tez_recipients;
    DELETE FROM tez_context;
    DELETE FROM tez;
    DELETE FROM conversation_members;
    DELETE FROM conversations;
    DELETE FROM contacts;
    DELETE FROM team_members;
    DELETE FROM teams;
  `);
}

/**
 * Close the test database client.
 */
export async function closeTestDb() {
  testClient?.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock the db module so routes use our in-memory DB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call this BEFORE importing the app. It sets up vi.mock for the db module.
 * Because vi.mock is hoisted, call setupDbMock() at module level in test files.
 */
export function setupDbMock() {
  vi.mock("../src/db/index.js", () => {
    // This factory runs lazily — by the time routes import it,
    // initTestDb() will have been called and testDb will exist.
    return {
      get db() {
        return testDb;
      },
      get getClient() {
        return () => testClient;
      },
      // Re-export all schema tables
      ...schema,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT token helpers
// ─────────────────────────────────────────────────────────────────────────────

const JWT_SECRET = "change-me-in-production"; // matches config.ts default
const jwtSecretBytes = new TextEncoder().encode(JWT_SECRET);

/**
 * Generate a valid JWT Bearer token for a test user.
 */
export async function generateToken(
  userId: string,
  options?: { email?: string; name?: string }
): Promise<string> {
  const token = await new SignJWT({
    email: options?.email,
    name: options?.name,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(jwtSecretBytes);

  return token;
}

/**
 * Return the Authorization header value for a test user.
 */
export async function authHeader(
  userId: string,
  options?: { email?: string; name?: string }
): Promise<string> {
  return `Bearer ${await generateToken(userId, options)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Team + member bootstrap helpers
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";

interface TeamSetup {
  teamId: string;
  adminUserId: string;
}

/**
 * Insert a team and its admin member directly into the test DB.
 * Returns teamId and adminUserId for use in tests.
 */
export async function createTeamWithAdmin(
  adminUserId: string = randomUUID(),
  teamName: string = "Test Team"
): Promise<TeamSetup> {
  const teamId = randomUUID();
  const now = new Date().toISOString();

  await testDb.insert(schema.teams).values({
    id: teamId,
    name: teamName,
    createdBy: adminUserId,
    createdAt: now,
    updatedAt: now,
  });

  await testDb.insert(schema.teamMembers).values({
    teamId,
    userId: adminUserId,
    role: "admin",
    joinedAt: now,
  });

  return { teamId, adminUserId };
}

/**
 * Add a regular member to an existing team.
 */
export async function addMember(
  teamId: string,
  userId: string,
  role: string = "member"
): Promise<void> {
  const now = new Date().toISOString();
  await testDb.insert(schema.teamMembers).values({
    teamId,
    userId,
    role,
    joinedAt: now,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test app factory
// ─────────────────────────────────────────────────────────────────────────────

import type { Express } from "express";

/**
 * Build a fresh Express app connected to the test DB.
 * Must be called AFTER initTestDb() and setupDbMock().
 */
export async function createTestApp(): Promise<Express> {
  // Dynamic import so the mock is already in place
  const express = (await import("express")).default;
  const cors = (await import("cors")).default;
  const { tezRoutes } = await import("../src/routes/tez.js");
  const { teamRoutes } = await import("../src/routes/teams.js");
  const { contactRoutes } = await import("../src/routes/contacts.js");
  const { conversationRoutes } = await import("../src/routes/conversations.js");
  const { unreadRoutes } = await import("../src/routes/unread.js");

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "tezit-relay-test" });
  });

  app.use("/tez", tezRoutes);
  app.use("/teams", teamRoutes);
  app.use("/contacts", contactRoutes);
  app.use("/conversations", conversationRoutes);
  app.use("/unread", unreadRoutes);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  return app;
}
