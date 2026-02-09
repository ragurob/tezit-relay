/**
 * DM Isolation Tests
 *
 * Proves that users who are NOT members of a DM conversation
 * cannot read, reply to, or view threads of tez messages in that conversation.
 *
 * This tests the assertTezAccess() ACL function which checks:
 * - Sender always has access to their own tez
 * - Team-scoped tez: requires team membership
 * - Conversation-scoped tez: requires conversation membership
 * - If neither scope matches: access denied
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
} from "./setup.js";

// Must call before any imports that touch the db
setupDbMock();

let app: Express;

const ALICE = "dm-alice";
const BOB = "dm-bob";
const OUTSIDER = "dm-outsider";

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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a DM between two users, return conversation ID */
async function createDM(userId: string, otherUserId: string): Promise<string> {
  const token = await authHeader(userId);
  const res = await request(app)
    .post("/conversations")
    .set("Authorization", token)
    .send({ type: "dm", memberIds: [otherUserId] });

  expect(res.status).toBe(201);
  return res.body.data.id;
}

/** Send a message in a conversation, return tez ID */
async function sendDMMessage(
  userId: string,
  conversationId: string,
  text: string
): Promise<string> {
  const token = await authHeader(userId);
  const res = await request(app)
    .post(`/conversations/${conversationId}/messages`)
    .set("Authorization", token)
    .send({ surfaceText: text });

  expect(res.status).toBe(201);
  return res.body.data.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /tez/:id — Outsider cannot read a DM tez
// ─────────────────────────────────────────────────────────────────────────────

describe("DM isolation — GET /tez/:id", () => {
  it("blocks outsider from reading a DM tez", async () => {
    const convId = await createDM(ALICE, BOB);
    const tezId = await sendDMMessage(ALICE, convId, "Private message to Bob");

    const token = await authHeader(OUTSIDER);
    const res = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("allows DM member to read the tez", async () => {
    const convId = await createDM(ALICE, BOB);
    const tezId = await sendDMMessage(ALICE, convId, "Private message to Bob");

    const token = await authHeader(BOB);
    const res = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(tezId);
    expect(res.body.data.surfaceText).toBe("Private message to Bob");
  });

  it("allows the sender to read their own DM tez", async () => {
    const convId = await createDM(ALICE, BOB);
    const tezId = await sendDMMessage(ALICE, convId, "My own message");

    const token = await authHeader(ALICE);
    const res = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(tezId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /tez/:id/thread — Outsider cannot read a DM thread
// ─────────────────────────────────────────────────────────────────────────────

describe("DM isolation — GET /tez/:id/thread", () => {
  it("blocks outsider from reading a DM thread", async () => {
    const convId = await createDM(ALICE, BOB);
    const tezId = await sendDMMessage(ALICE, convId, "Thread root in DM");

    const token = await authHeader(OUTSIDER);
    const res = await request(app)
      .get(`/tez/${tezId}/thread`)
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("allows DM member to read the thread", async () => {
    const convId = await createDM(ALICE, BOB);
    const tezId = await sendDMMessage(ALICE, convId, "Thread root in DM");

    const token = await authHeader(BOB);
    const res = await request(app)
      .get(`/tez/${tezId}/thread`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
    expect(res.body.data.messages[0].surfaceText).toBe("Thread root in DM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /tez/:id/reply — Outsider cannot reply to a DM tez
// ─────────────────────────────────────────────────────────────────────────────

describe("DM isolation — POST /tez/:id/reply", () => {
  it("blocks outsider from replying to a DM tez", async () => {
    const convId = await createDM(ALICE, BOB);
    const tezId = await sendDMMessage(ALICE, convId, "DM that outsider cannot reply to");

    const token = await authHeader(OUTSIDER);
    const res = await request(app)
      .post(`/tez/${tezId}/reply`)
      .set("Authorization", token)
      .send({ surfaceText: "I should not be able to reply" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("allows DM member to reply", async () => {
    const convId = await createDM(ALICE, BOB);
    const tezId = await sendDMMessage(ALICE, convId, "DM that Bob can reply to");

    const token = await authHeader(BOB);
    const res = await request(app)
      .post(`/tez/${tezId}/reply`)
      .set("Authorization", token)
      .send({ surfaceText: "Bob's reply" });

    expect(res.status).toBe(201);
    expect(res.body.data.parentTezId).toBe(tezId);
    expect(res.body.data.surfaceText).toBe("Bob's reply");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Context isolation — Outsider cannot read context layers on a DM tez
// ─────────────────────────────────────────────────────────────────────────────

describe("DM isolation — context layers", () => {
  it("blocks outsider from reading context-rich DM tez", async () => {
    const convId = await createDM(ALICE, BOB);

    // Send a DM with context layers
    const aliceToken = await authHeader(ALICE);
    const msgRes = await request(app)
      .post(`/conversations/${convId}/messages`)
      .set("Authorization", aliceToken)
      .send({
        surfaceText: "Confidential report for Bob",
        context: [
          { layer: "background", content: "Q4 financials" },
          { layer: "fact", content: "Revenue: $5M", confidence: 100, source: "verified" },
          { layer: "constraint", content: "Board eyes only" },
        ],
      });
    expect(msgRes.status).toBe(201);
    const tezId = msgRes.body.data.id;

    // Outsider cannot access the tez at all (so they can't see context)
    const outsiderToken = await authHeader(OUTSIDER);
    const res = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", outsiderToken);

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();

    // Bob CAN see the full tez with context
    const bobToken = await authHeader(BOB);
    const bobRes = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", bobToken);

    expect(bobRes.status).toBe(200);
    expect(bobRes.body.data.context).toHaveLength(3);
    expect(bobRes.body.data.context[0].content).toBe("Q4 financials");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group conversation isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("Group conversation isolation", () => {
  it("blocks outsider from reading a group conversation tez", async () => {
    // Create group with Alice, Bob (not outsider)
    const aliceToken = await authHeader(ALICE);
    const groupRes = await request(app)
      .post("/conversations")
      .set("Authorization", aliceToken)
      .send({ type: "group", memberIds: [BOB], name: "Secret Project" });
    expect(groupRes.status).toBe(201);
    const convId = groupRes.body.data.id;

    const tezId = await sendDMMessage(ALICE, convId, "Group-only message");

    // Outsider blocked
    const outsiderToken = await authHeader(OUTSIDER);
    const res = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", outsiderToken);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");

    // Bob (group member) can read
    const bobToken = await authHeader(BOB);
    const bobRes = await request(app)
      .get(`/tez/${tezId}`)
      .set("Authorization", bobToken);

    expect(bobRes.status).toBe(200);
    expect(bobRes.body.data.surfaceText).toBe("Group-only message");
  });
});
