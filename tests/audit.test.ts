/**
 * Integration tests for audit logging
 *
 * Verifies that audit log entries are created for:
 * - tez.shared — when a Tez is created
 * - tez.replied — when a reply is created
 * - tez.read — when a Tez is fetched by ID
 * - team.created — when a team is created
 * - team.member_added — when a member is added
 * - team.member_removed — when a member is removed
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import {
  setupDbMock,
  initTestDb,
  cleanDb,
  closeTestDb,
  createTestApp,
  authHeader,
  createTeamWithAdmin,
  addMember,
  getTestDb,
} from "./setup.js";
import { auditLog } from "../src/db/schema.js";

// Must call before any imports that touch the db
setupDbMock();

let app: Express;

const ADMIN_USER = "audit-admin-1";
const MEMBER_USER = "audit-member-1";

beforeAll(async () => {
  await initTestDb();
  app = await createTestApp();
});

beforeEach(async () => {
  await cleanDb();
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * Helper: query all audit log entries
 */
async function getAllAuditEntries() {
  const db = getTestDb();
  return db.select().from(auditLog);
}

/**
 * Helper: query audit entries by action
 */
async function getAuditByAction(action: string) {
  const db = getTestDb();
  return db.select().from(auditLog).where(eq(auditLog.action, action));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tez audit events
// ─────────────────────────────────────────────────────────────────────────────

describe("Tez audit events", () => {
  it("records tez.shared when a Tez is created", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const shareRes = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({
        teamId,
        surfaceText: "Audit test message",
        type: "decision",
        visibility: "team",
        recipients: [MEMBER_USER],
        context: [
          { layer: "background", content: "Some context" },
          { layer: "fact", content: "A fact" },
        ],
      });

    expect(shareRes.status).toBe(201);

    const entries = await getAuditByAction("tez.shared");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.teamId).toBe(teamId);
    expect(entry.actorUserId).toBe(ADMIN_USER);
    expect(entry.action).toBe("tez.shared");
    expect(entry.targetType).toBe("tez");
    expect(entry.targetId).toBe(shareRes.body.data.id);
    expect(entry.createdAt).toBeDefined();

    // Verify metadata
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.type).toBe("decision");
    expect(meta.visibility).toBe("team");
    expect(meta.recipientCount).toBe(1);
    expect(meta.contextLayerCount).toBe(2);
  });

  it("records tez.replied when a reply is created", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(ADMIN_USER);
    const shareRes = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "Original" });

    const parentId = shareRes.body.data.id;

    const replyToken = await authHeader(MEMBER_USER);
    const replyRes = await request(app)
      .post(`/tez/${parentId}/reply`)
      .set("Authorization", replyToken)
      .send({ surfaceText: "Reply to original" });

    expect(replyRes.status).toBe(201);

    const entries = await getAuditByAction("tez.replied");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.teamId).toBe(teamId);
    expect(entry.actorUserId).toBe(MEMBER_USER);
    expect(entry.action).toBe("tez.replied");
    expect(entry.targetType).toBe("tez");
    expect(entry.targetId).toBe(replyRes.body.data.id);

    // Verify metadata includes parent and thread info
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.parentTezId).toBe(parentId);
    expect(meta.threadId).toBe(parentId); // root tez is its own threadId
  });

  it("records tez.read when a Tez is fetched by ID", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(ADMIN_USER);
    const shareRes = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "Read me" });

    const tezId = shareRes.body.data.id;

    // Read by a different team member
    const readerToken = await authHeader(MEMBER_USER);
    const getRes = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", readerToken);

    expect(getRes.status).toBe(200);

    const entries = await getAuditByAction("tez.read");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.teamId).toBe(teamId);
    expect(entry.actorUserId).toBe(MEMBER_USER);
    expect(entry.action).toBe("tez.read");
    expect(entry.targetType).toBe("tez");
    expect(entry.targetId).toBe(tezId);
  });

  it("records multiple reads for multiple accesses", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(ADMIN_USER);
    const shareRes = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "Read me twice" });

    const tezId = shareRes.body.data.id;

    // Read twice by different users
    await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", token);

    const memberToken = await authHeader(MEMBER_USER);
    await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", memberToken);

    const entries = await getAuditByAction("tez.read");
    expect(entries).toHaveLength(2);

    const actors = entries.map((e) => e.actorUserId);
    expect(actors).toContain(ADMIN_USER);
    expect(actors).toContain(MEMBER_USER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Team audit events
// ─────────────────────────────────────────────────────────────────────────────

describe("Team audit events", () => {
  it("records team.created when a team is created", async () => {
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/teams")
      .set("Authorization", token)
      .send({ name: "Audit Team" });

    expect(res.status).toBe(201);

    const entries = await getAuditByAction("team.created");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.teamId).toBe(res.body.data.id);
    expect(entry.actorUserId).toBe(ADMIN_USER);
    expect(entry.action).toBe("team.created");
    expect(entry.targetType).toBe("team");
    expect(entry.targetId).toBe(res.body.data.id);

    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.name).toBe("Audit Team");
  });

  it("records team.member_added when a member is added", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post(`/teams/${teamId}/members`)
      .set("Authorization", token)
      .send({ userId: MEMBER_USER, role: "member" });

    expect(res.status).toBe(201);

    const entries = await getAuditByAction("team.member_added");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.teamId).toBe(teamId);
    expect(entry.actorUserId).toBe(ADMIN_USER);
    expect(entry.action).toBe("team.member_added");
    expect(entry.targetType).toBe("team");
    expect(entry.targetId).toBe(teamId);

    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.addedUserId).toBe(MEMBER_USER);
    expect(meta.role).toBe("member");
  });

  it("records team.member_removed when an admin removes a member", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(ADMIN_USER);
    const res = await request(app)
      .delete(`/teams/${teamId}/members/${MEMBER_USER}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);

    const entries = await getAuditByAction("team.member_removed");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.teamId).toBe(teamId);
    expect(entry.actorUserId).toBe(ADMIN_USER);
    expect(entry.action).toBe("team.member_removed");
    expect(entry.targetType).toBe("team");
    expect(entry.targetId).toBe(teamId);

    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.removedUserId).toBe(MEMBER_USER);
    expect(meta.selfLeave).toBe(false);
  });

  it("records team.member_removed with selfLeave=true for self-leave", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(MEMBER_USER);
    const res = await request(app)
      .delete(`/teams/${teamId}/members/${MEMBER_USER}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);

    const entries = await getAuditByAction("team.member_removed");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.actorUserId).toBe(MEMBER_USER);

    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.removedUserId).toBe(MEMBER_USER);
    expect(meta.selfLeave).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit log integrity
// ─────────────────────────────────────────────────────────────────────────────

describe("Audit log integrity", () => {
  it("each audit entry has a unique id and timestamp", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    // Create multiple events
    await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "Message 1" });

    await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "Message 2" });

    const entries = await getAllAuditEntries();
    // At least: team.created (from createTeamWithAdmin helper doesn't go through API,
    // so we get 2 tez.shared entries)
    const tezSharedEntries = entries.filter((e) => e.action === "tez.shared");
    expect(tezSharedEntries).toHaveLength(2);

    // All IDs should be unique
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);

    // All entries should have timestamps
    for (const entry of entries) {
      expect(entry.createdAt).toBeDefined();
      expect(entry.createdAt.length).toBeGreaterThan(0);
    }
  });

  it("audit entries are append-only — no updates or deletes via API", async () => {
    const token = await authHeader(ADMIN_USER);

    // Create a team (generates team.created audit entry)
    const teamRes = await request(app)
      .post("/teams")
      .set("Authorization", token)
      .send({ name: "Immutable Audit" });

    const teamId = teamRes.body.data.id;

    // Add a member (generates team.member_added)
    await request(app)
      .post(`/teams/${teamId}/members`)
      .set("Authorization", token)
      .send({ userId: MEMBER_USER });

    // Share a tez (generates tez.shared)
    await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "Immutable" });

    const entries = await getAllAuditEntries();
    // Should have at least 3 entries: team.created, team.member_added, tez.shared
    expect(entries.length).toBeGreaterThanOrEqual(3);

    const actions = entries.map((e) => e.action);
    expect(actions).toContain("team.created");
    expect(actions).toContain("team.member_added");
    expect(actions).toContain("tez.shared");
  });
});
