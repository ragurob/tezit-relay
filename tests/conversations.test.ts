/**
 * Integration tests for conversation + unread endpoints
 *
 * POST /conversations              — Create DM or group
 * GET  /conversations              — List my conversations
 * GET  /conversations/:id/messages — Get messages in conversation
 * POST /conversations/:id/messages — Send message in conversation
 * POST /conversations/:id/read     — Mark conversation as read
 * GET  /unread                     — Get unread counts
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

const USER_A = "conv-user-a";
const USER_B = "conv-user-b";
const USER_C = "conv-user-c";
const OUTSIDER = "conv-outsider";

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
// Helper: create a DM and return the response
// ─────────────────────────────────────────────────────────────────────────────

async function createDM(userId: string, otherUserId: string) {
  const token = await authHeader(userId);
  return request(app)
    .post("/conversations")
    .set("Authorization", token)
    .send({
      type: "dm",
      memberIds: [otherUserId],
    });
}

async function createGroup(
  userId: string,
  memberIds: string[],
  name: string
) {
  const token = await authHeader(userId);
  return request(app)
    .post("/conversations")
    .set("Authorization", token)
    .send({
      type: "group",
      memberIds,
      name,
    });
}

async function sendMessage(
  userId: string,
  conversationId: string,
  surfaceText: string,
  overrides: Record<string, unknown> = {}
) {
  const token = await authHeader(userId);
  return request(app)
    .post(`/conversations/${conversationId}/messages`)
    .set("Authorization", token)
    .send({ surfaceText, ...overrides });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations — Create DM or group
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /conversations — DM", () => {
  it("creates a DM between two users", async () => {
    const res = await createDM(USER_A, USER_B);

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.type).toBe("dm");
    expect(res.body.data.name).toBeNull();
    expect(res.body.data.members).toHaveLength(2);

    const memberIds = res.body.data.members.map((m: { userId: string }) => m.userId);
    expect(memberIds).toContain(USER_A);
    expect(memberIds).toContain(USER_B);
  });

  it("returns existing DM if already exists", async () => {
    const first = await createDM(USER_A, USER_B);
    expect(first.status).toBe(201);

    const second = await createDM(USER_A, USER_B);
    expect(second.status).toBe(201);

    // Same conversation ID
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it("returns existing DM when created from the other side", async () => {
    const first = await createDM(USER_A, USER_B);
    expect(first.status).toBe(201);

    // USER_B creates DM with USER_A
    const second = await createDM(USER_B, USER_A);
    expect(second.status).toBe(201);

    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it("returns 400 for DM with wrong member count", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .post("/conversations")
      .set("Authorization", token)
      .send({
        type: "dm",
        memberIds: [USER_B, USER_C],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/conversations")
      .send({ type: "dm", memberIds: [USER_B] });

    expect(res.status).toBe(401);
  });
});

describe("POST /conversations — Group", () => {
  it("creates a group conversation", async () => {
    const res = await createGroup(USER_A, [USER_B, USER_C], "Project Team");

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("group");
    expect(res.body.data.name).toBe("Project Team");
    expect(res.body.data.members).toHaveLength(3);

    const memberIds = res.body.data.members.map((m: { userId: string }) => m.userId);
    expect(memberIds).toContain(USER_A);
    expect(memberIds).toContain(USER_B);
    expect(memberIds).toContain(USER_C);
  });

  it("returns 400 for group without name", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .post("/conversations")
      .set("Authorization", token)
      .send({
        type: "group",
        memberIds: [USER_B, USER_C],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for group with empty memberIds", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .post("/conversations")
      .set("Authorization", token)
      .send({
        type: "group",
        memberIds: [],
        name: "Empty Group",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("auto-includes creator in member list", async () => {
    // Only specify USER_B, not USER_A
    const token = await authHeader(USER_A);
    const res = await request(app)
      .post("/conversations")
      .set("Authorization", token)
      .send({
        type: "group",
        memberIds: [USER_B],
        name: "Auto Include",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.members).toHaveLength(2);

    const memberIds = res.body.data.members.map((m: { userId: string }) => m.userId);
    expect(memberIds).toContain(USER_A);
    expect(memberIds).toContain(USER_B);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations — List my conversations
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /conversations", () => {
  it("lists conversations the user is in", async () => {
    await createDM(USER_A, USER_B);
    await createGroup(USER_A, [USER_B, USER_C], "Team Chat");

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/conversations")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it("does not list conversations the user is not in", async () => {
    await createDM(USER_A, USER_B);

    const token = await authHeader(USER_C);
    const res = await request(app)
      .get("/conversations")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("includes last message preview", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    await sendMessage(USER_A, convId, "Hello!");
    await new Promise((r) => setTimeout(r, 10));
    await sendMessage(USER_B, convId, "Hi there!");

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/conversations")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].lastMessage).toBeDefined();
    expect(res.body.data[0].lastMessage.surfaceText).toBe("Hi there!");
  });

  it("includes unread count", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    await sendMessage(USER_A, convId, "Message 1");
    await sendMessage(USER_B, convId, "Message 2");

    // USER_A has never read, so both messages are "unread"
    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/conversations")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data[0].unreadCount).toBe(2);
  });

  it("returns empty array when user has no conversations", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/conversations")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/conversations");
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations/:id/messages — Send message
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /conversations/:id/messages", () => {
  it("sends a message in a conversation", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    const res = await sendMessage(USER_A, convId, "Hello world!");

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.conversationId).toBe(convId);
    expect(res.body.data.surfaceText).toBe("Hello world!");
    expect(res.body.data.senderUserId).toBe(USER_A);
    expect(res.body.data.createdAt).toBeDefined();
  });

  it("sends a message with context layers", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    const token = await authHeader(USER_A);
    const res = await request(app)
      .post(`/conversations/${convId}/messages`)
      .set("Authorization", token)
      .send({
        surfaceText: "Here is the report",
        context: [
          {
            layer: "background",
            content: "Q4 results summary",
          },
          {
            layer: "fact",
            content: "Revenue grew 15%",
            confidence: 95,
            source: "verified",
          },
        ],
      });

    expect(res.status).toBe(201);
  });

  it("returns 403 for non-member sending", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    const res = await sendMessage(OUTSIDER, convId, "I should not be able to send");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 for missing surfaceText", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    const token = await authHeader(USER_A);
    const res = await request(app)
      .post(`/conversations/${convId}/messages`)
      .set("Authorization", token)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for empty surfaceText", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    const token = await authHeader(USER_A);
    const res = await request(app)
      .post(`/conversations/${convId}/messages`)
      .set("Authorization", token)
      .send({ surfaceText: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/conversations/some-id/messages")
      .send({ surfaceText: "No auth" });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations/:id/messages — Get messages
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /conversations/:id/messages", () => {
  it("returns messages in a conversation (newest first)", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    await sendMessage(USER_A, convId, "First message");
    await new Promise((r) => setTimeout(r, 10));
    await sendMessage(USER_B, convId, "Second message");

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get(`/conversations/${convId}/messages`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.count).toBe(2);
    // Newest first
    expect(res.body.data[0].surfaceText).toBe("Second message");
    expect(res.body.data[1].surfaceText).toBe("First message");
  });

  it("supports cursor pagination with before param", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    for (let i = 0; i < 5; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 10));
      await sendMessage(USER_A, convId, `Message ${i + 1}`);
    }

    const token = await authHeader(USER_A);
    const page1 = await request(app)
      .get(`/conversations/${convId}/messages`)
      .query({ limit: "3" })
      .set("Authorization", token);

    expect(page1.body.data).toHaveLength(3);
    expect(page1.body.meta.hasMore).toBe(true);

    const cursor = page1.body.data[page1.body.data.length - 1].createdAt;
    const page2 = await request(app)
      .get(`/conversations/${convId}/messages`)
      .query({ limit: "3", before: cursor })
      .set("Authorization", token);

    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.meta.hasMore).toBe(false);
  });

  it("returns 403 for non-member", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    const token = await authHeader(OUTSIDER);
    const res = await request(app)
      .get(`/conversations/${convId}/messages`)
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns empty messages for conversation with no messages", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get(`/conversations/${convId}/messages`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/conversations/some-id/messages");
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations/:id/read — Mark as read
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /conversations/:id/read", () => {
  it("marks conversation as read", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    await sendMessage(USER_A, convId, "Hello");
    await sendMessage(USER_B, convId, "Hi");

    const token = await authHeader(USER_A);
    const res = await request(app)
      .post(`/conversations/${convId}/read`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);

    // Now unread count should be 0 for this user
    const listRes = await request(app)
      .get("/conversations")
      .set("Authorization", token);

    expect(listRes.body.data[0].unreadCount).toBe(0);
  });

  it("returns 403 for non-member", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    const token = await authHeader(OUTSIDER);
    const res = await request(app)
      .post(`/conversations/${convId}/read`)
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).post("/conversations/some-id/read");
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /unread — Unread counts
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /unread", () => {
  it("returns unread counts for conversations", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    await sendMessage(USER_A, convId, "Message 1");
    await sendMessage(USER_B, convId, "Message 2");

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/unread")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.conversations).toHaveLength(1);
    expect(res.body.data.conversations[0].conversationId).toBe(convId);
    expect(res.body.data.conversations[0].count).toBe(2);
    expect(res.body.data.total).toBeGreaterThanOrEqual(2);
  });

  it("returns zero unread after marking as read", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    await sendMessage(USER_A, convId, "Hello");

    // Mark as read
    const token = await authHeader(USER_A);
    await request(app)
      .post(`/conversations/${convId}/read`)
      .set("Authorization", token);

    const res = await request(app)
      .get("/unread")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    // The conversation should not appear in unread list (count = 0)
    const convEntry = res.body.data.conversations.find(
      (c: { conversationId: string }) => c.conversationId === convId
    );
    expect(convEntry).toBeUndefined();
  });

  it("counts new messages after last read", async () => {
    const dmRes = await createDM(USER_A, USER_B);
    const convId = dmRes.body.data.id;

    await sendMessage(USER_A, convId, "Old message");

    // Mark as read
    const token = await authHeader(USER_A);
    await request(app)
      .post(`/conversations/${convId}/read`)
      .set("Authorization", token);

    // Wait a bit to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 10));

    // New messages arrive
    await sendMessage(USER_B, convId, "New message 1");
    await sendMessage(USER_B, convId, "New message 2");

    const res = await request(app)
      .get("/unread")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    const convEntry = res.body.data.conversations.find(
      (c: { conversationId: string }) => c.conversationId === convId
    );
    expect(convEntry).toBeDefined();
    expect(convEntry.count).toBe(2);
  });

  it("returns empty when no unreads", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/unread")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.teams).toHaveLength(0);
    expect(res.body.data.conversations).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/unread");
    expect(res.status).toBe(401);
  });
});
