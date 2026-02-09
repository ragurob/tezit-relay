/**
 * Integration tests for Tez endpoints
 *
 * POST /tez/share        — Send a Tez (create + deliver)
 * GET  /tez/stream       — Get feed for authenticated user
 * POST /tez/:id/reply    — Reply to a Tez (threaded)
 * GET  /tez/:id          — Get full Tez with context + provenance
 * GET  /tez/:id/thread   — Get full thread
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  setupDbMock,
  initTestDb,
  cleanDb,
  closeTestDb,
  createTestApp,
  authHeader,
  createTeamWithAdmin,
  addMember,
} from "./setup.js";

// Must call before any imports that touch the db
setupDbMock();

let app: Express;

const ADMIN_USER = "tez-admin-1";
const MEMBER_USER = "tez-member-1";
const MEMBER_USER_2 = "tez-member-2";
const OUTSIDER_USER = "tez-outsider-1";

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

// ─────────────────────────────────────────────────────────────────────────────
// Helper: share a Tez and return the response body
// ─────────────────────────────────────────────────────────────────────────────

async function shareTez(
  teamId: string,
  senderUserId: string,
  overrides: Record<string, unknown> = {}
) {
  const token = await authHeader(senderUserId);
  const payload = {
    teamId,
    surfaceText: "Default test message",
    type: "note",
    ...overrides,
  };

  return request(app)
    .post("/tez/share")
    .set("Authorization", token)
    .send(payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /tez/share — Send a Tez
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /tez/share", () => {
  it("creates a Tez with minimal fields", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({
        teamId,
        surfaceText: "We need to ship the feature by Friday",
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.threadId).toBe(res.body.data.id); // root of new thread
    expect(res.body.data.surfaceText).toBe(
      "We need to ship the feature by Friday"
    );
    expect(res.body.data.type).toBe("note"); // default
    expect(res.body.data.createdAt).toBeDefined();
  });

  it("creates a Tez with context layers", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({
        teamId,
        surfaceText: "Database migration plan",
        type: "decision",
        urgency: "high",
        actionRequested: "Review and approve by EOD",
        recipients: [MEMBER_USER],
        context: [
          {
            layer: "background",
            content: "Current DB is hitting performance limits at 10k QPS",
          },
          {
            layer: "fact",
            content: "PostgreSQL 16 supports parallel query improvements",
            confidence: 95,
            source: "verified",
          },
          {
            layer: "constraint",
            content: "Migration must happen during weekend maintenance window",
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("decision");

    // Verify context was stored by fetching the full tez
    const tezId = res.body.data.id;
    const getRes = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", token);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.context).toHaveLength(3);
    expect(getRes.body.data.context[0].layer).toBe("background");
    expect(getRes.body.data.context[1].confidence).toBe(95);
    expect(getRes.body.data.context[1].source).toBe("verified");

    // Verify recipients were stored
    expect(getRes.body.data.recipients).toHaveLength(1);
    expect(getRes.body.data.recipients[0].userId).toBe(MEMBER_USER);
  });

  it("creates a Tez with all valid types", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const types = ["note", "decision", "handoff", "question", "update"];
    for (const type of types) {
      const res = await request(app)
        .post("/tez/share")
        .set("Authorization", token)
        .send({ teamId, surfaceText: `Test ${type}`, type });

      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe(type);
    }
  });

  it("creates a Tez with all valid urgency levels", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const levels = ["critical", "high", "normal", "low", "fyi"];
    for (const urgency of levels) {
      const res = await request(app)
        .post("/tez/share")
        .set("Authorization", token)
        .send({ teamId, surfaceText: `Test ${urgency}`, urgency });

      expect(res.status).toBe(201);
    }
  });

  it("creates a Tez with all valid context layers", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const layers = [
      "background",
      "fact",
      "artifact",
      "relationship",
      "constraint",
      "hint",
    ];
    const context = layers.map((layer) => ({
      layer,
      content: `Test content for ${layer}`,
    }));

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "All layers", context });

    expect(res.status).toBe(201);

    // Verify all layers stored
    const getRes = await request(app)
      .get(`/tez/${res.body.data.id}`)
      .set("Authorization", token);

    expect(getRes.body.data.context).toHaveLength(6);
  });

  // ── Validation errors ──

  it("returns 400 for missing surfaceText", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for empty surfaceText", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid type", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "Test", type: "invalid-type" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for missing teamId", async () => {
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ surfaceText: "No team" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid context layer", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({
        teamId,
        surfaceText: "Bad layer",
        context: [{ layer: "nonexistent", content: "test" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ── ACL ──

  it("returns 403 for non-member trying to share", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(OUTSIDER_USER);

    const res = await request(app)
      .post("/tez/share")
      .set("Authorization", token)
      .send({ teamId, surfaceText: "I am not in this team" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app)
      .post("/tez/share")
      .send({ teamId: "some-id", surfaceText: "No auth" });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /tez/stream — Get feed
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /tez/stream", () => {
  it("returns team tezits for a member", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    // Share a couple of tezits with a small delay to ensure distinct timestamps
    await shareTez(teamId, ADMIN_USER, { surfaceText: "First message" });
    // Ensure the second message gets a strictly later timestamp
    await new Promise((r) => setTimeout(r, 10));
    await shareTez(teamId, MEMBER_USER, { surfaceText: "Second message" });

    const token = await authHeader(MEMBER_USER);
    const res = await request(app)
      .get("/tez/stream")
      .query({ teamId })
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.count).toBe(2);
    // Ordered by createdAt DESC — newest first
    expect(res.body.data[0].surfaceText).toBe("Second message");
    expect(res.body.data[1].surfaceText).toBe("First message");
  });

  it("respects team scoping — no cross-team leakage", async () => {
    const { teamId: team1 } = await createTeamWithAdmin(ADMIN_USER);
    const { teamId: team2 } = await createTeamWithAdmin(MEMBER_USER, "Team 2");

    await shareTez(team1, ADMIN_USER, { surfaceText: "Team 1 message" });
    await shareTez(team2, MEMBER_USER, { surfaceText: "Team 2 message" });

    // Admin is only in team1
    const token = await authHeader(ADMIN_USER);
    const res = await request(app)
      .get("/tez/stream")
      .query({ teamId: team1 })
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].surfaceText).toBe("Team 1 message");
  });

  it("supports cursor pagination with before param", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    // Share tezits with delays to ensure strictly distinct timestamps
    for (let i = 0; i < 5; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 10));
      await shareTez(teamId, ADMIN_USER, {
        surfaceText: `Message ${i + 1}`,
      });
    }

    // Get first page (newest 3)
    const page1 = await request(app)
      .get("/tez/stream")
      .query({ teamId, limit: "3" })
      .set("Authorization", token);

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(3);
    expect(page1.body.meta.hasMore).toBe(true);

    // Use the oldest item's createdAt as cursor
    const cursor = page1.body.data[page1.body.data.length - 1].createdAt;

    const page2 = await request(app)
      .get("/tez/stream")
      .query({ teamId, limit: "3", before: cursor })
      .set("Authorization", token);

    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.meta.hasMore).toBe(false);

    // Ensure no duplicates between pages
    const page1Ids = page1.body.data.map((t: { id: string }) => t.id);
    const page2Ids = page2.body.data.map((t: { id: string }) => t.id);
    const allIds = [...page1Ids, ...page2Ids];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("returns empty stream for team with no tezits", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .get("/tez/stream")
      .query({ teamId })
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.count).toBe(0);
  });

  it("returns 400 without teamId query param", async () => {
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .get("/tez/stream")
      .set("Authorization", token);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_TEAM");
  });

  it("returns 403 for non-member", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(OUTSIDER_USER);

    const res = await request(app)
      .get("/tez/stream")
      .query({ teamId })
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .get("/tez/stream")
      .query({ teamId: "some-id" });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /tez/:id/reply — Reply to a Tez (threaded)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /tez/:id/reply", () => {
  it("creates a threaded reply", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    // Create the original tez
    const shareRes = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "What do you think about the proposal?",
      type: "question",
    });
    const parentId = shareRes.body.data.id;
    const parentThreadId = shareRes.body.data.threadId;

    // Reply
    const token = await authHeader(MEMBER_USER);
    const replyRes = await request(app)
      .post(`/tez/${parentId}/reply`)
      .set("Authorization", token)
      .send({
        surfaceText: "Looks good, but I have concerns about the timeline",
        type: "note",
      });

    expect(replyRes.status).toBe(201);
    expect(replyRes.body.data.parentTezId).toBe(parentId);
    expect(replyRes.body.data.threadId).toBe(parentThreadId);
    expect(replyRes.body.data.surfaceText).toBe(
      "Looks good, but I have concerns about the timeline"
    );
  });

  it("reply inherits the thread from a nested reply", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);
    await addMember(teamId, MEMBER_USER_2);

    // Root tez
    const root = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Root message",
    });
    const rootId = root.body.data.id;
    const threadId = root.body.data.threadId;

    // First reply
    const reply1Token = await authHeader(MEMBER_USER);
    const reply1 = await request(app)
      .post(`/tez/${rootId}/reply`)
      .set("Authorization", reply1Token)
      .send({ surfaceText: "First reply" });

    const reply1Id = reply1.body.data.id;

    // Reply to the reply (not the root)
    const reply2Token = await authHeader(MEMBER_USER_2);
    const reply2 = await request(app)
      .post(`/tez/${reply1Id}/reply`)
      .set("Authorization", reply2Token)
      .send({ surfaceText: "Reply to reply" });

    expect(reply2.status).toBe(201);
    // All replies share the same threadId (the root)
    expect(reply2.body.data.threadId).toBe(threadId);
    expect(reply2.body.data.parentTezId).toBe(reply1Id);
  });

  it("reply can include context layers", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const shareRes = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Need budget approval",
    });

    const token = await authHeader(MEMBER_USER);
    const replyRes = await request(app)
      .post(`/tez/${shareRes.body.data.id}/reply`)
      .set("Authorization", token)
      .send({
        surfaceText: "Approved with conditions",
        context: [
          {
            layer: "fact",
            content: "Budget cap is $50k",
            confidence: 100,
            source: "stated",
          },
          {
            layer: "constraint",
            content: "Must use existing vendor contracts",
          },
        ],
      });

    expect(replyRes.status).toBe(201);

    // Verify context on the reply
    const getRes = await request(app)
      .get(`/tez/${replyRes.body.data.id}`)
      .set("Authorization", token);

    expect(getRes.body.data.context).toHaveLength(2);
  });

  it("returns 404 for non-existent parent", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/tez/nonexistent-id/reply")
      .set("Authorization", token)
      .send({ surfaceText: "Reply to nothing" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 403 for non-member replying", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const shareRes = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Only for team members",
    });

    const token = await authHeader(OUTSIDER_USER);
    const res = await request(app)
      .post(`/tez/${shareRes.body.data.id}/reply`)
      .set("Authorization", token)
      .send({ surfaceText: "I am not in this team" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 for missing surfaceText in reply", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const shareRes = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Parent",
    });

    const token = await authHeader(ADMIN_USER);
    const res = await request(app)
      .post(`/tez/${shareRes.body.data.id}/reply`)
      .set("Authorization", token)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/tez/some-id/reply")
      .send({ surfaceText: "No auth" });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /tez/:id — Get full Tez with context + recipients
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /tez/:id", () => {
  it("returns full Tez with context and recipients", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const shareRes = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Quarterly review summary",
      type: "update",
      urgency: "high",
      recipients: [MEMBER_USER],
      context: [
        {
          layer: "background",
          content: "Q4 results are in",
        },
        {
          layer: "fact",
          content: "Revenue up 15% YoY",
          confidence: 100,
          source: "verified",
        },
      ],
    });

    const token = await authHeader(ADMIN_USER);
    const res = await request(app)
      .get(`/tez/${shareRes.body.data.id}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(shareRes.body.data.id);
    expect(res.body.data.surfaceText).toBe("Quarterly review summary");
    expect(res.body.data.type).toBe("update");
    expect(res.body.data.urgency).toBe("high");
    expect(res.body.data.senderUserId).toBe(ADMIN_USER);

    // Context layers
    expect(res.body.data.context).toHaveLength(2);
    const bgCtx = res.body.data.context.find(
      (c: { layer: string }) => c.layer === "background"
    );
    expect(bgCtx.content).toBe("Q4 results are in");

    const factCtx = res.body.data.context.find(
      (c: { layer: string }) => c.layer === "fact"
    );
    expect(factCtx.confidence).toBe(100);
    expect(factCtx.source).toBe("verified");

    // Recipients
    expect(res.body.data.recipients).toHaveLength(1);
    expect(res.body.data.recipients[0].userId).toBe(MEMBER_USER);
    expect(res.body.data.recipients[0].deliveredAt).toBeDefined();
  });

  it("returns 404 for non-existent Tez", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .get("/tez/nonexistent-uuid")
      .set("Authorization", token);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 403 for non-member reading", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const shareRes = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Private to team",
    });

    const token = await authHeader(OUTSIDER_USER);
    const res = await request(app)
      .get(`/tez/${shareRes.body.data.id}`)
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns Tez with empty context and recipients", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const shareRes = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Simple message, no context or recipients",
    });

    const res = await request(app)
      .get(`/tez/${shareRes.body.data.id}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.context).toHaveLength(0);
    expect(res.body.data.recipients).toHaveLength(0);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/tez/some-id");

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /tez/:id/thread — Get full conversation thread
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /tez/:id/thread", () => {
  it("returns all messages in a thread, chronologically", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    // Create root + 2 replies
    const root = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Thread root",
    });
    const rootId = root.body.data.id;

    const reply1Token = await authHeader(MEMBER_USER);
    const reply1 = await request(app)
      .post(`/tez/${rootId}/reply`)
      .set("Authorization", reply1Token)
      .send({ surfaceText: "Reply 1" });

    const reply2Token = await authHeader(ADMIN_USER);
    const reply2 = await request(app)
      .post(`/tez/${rootId}/reply`)
      .set("Authorization", reply2Token)
      .send({ surfaceText: "Reply 2" });

    // Fetch thread
    const token = await authHeader(MEMBER_USER);
    const res = await request(app)
      .get(`/tez/${rootId}/thread`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.threadId).toBe(rootId);
    expect(res.body.data.rootTezId).toBe(rootId);
    expect(res.body.data.messageCount).toBe(3);
    expect(res.body.data.messages).toHaveLength(3);

    // Chronological order
    expect(res.body.data.messages[0].surfaceText).toBe("Thread root");
    expect(res.body.data.messages[1].surfaceText).toBe("Reply 1");
    expect(res.body.data.messages[2].surfaceText).toBe("Reply 2");
  });

  it("can fetch thread from any message in the thread", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const root = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Root",
    });
    const rootId = root.body.data.id;

    const replyToken = await authHeader(MEMBER_USER);
    const reply = await request(app)
      .post(`/tez/${rootId}/reply`)
      .set("Authorization", replyToken)
      .send({ surfaceText: "Reply" });
    const replyId = reply.body.data.id;

    // Fetch thread using the reply's ID
    const token = await authHeader(ADMIN_USER);
    const res = await request(app)
      .get(`/tez/${replyId}/thread`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    // Should still return the full thread
    expect(res.body.data.messageCount).toBe(2);
  });

  it("returns 404 for non-existent Tez", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .get("/tez/nonexistent-id/thread")
      .set("Authorization", token);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 403 for non-member", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const shareRes = await shareTez(teamId, ADMIN_USER, {
      surfaceText: "Thread root",
    });

    const token = await authHeader(OUTSIDER_USER);
    const res = await request(app)
      .get(`/tez/${shareRes.body.data.id}/thread`)
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/tez/some-id/thread");

    expect(res.status).toBe(401);
  });
});
