/**
 * Integration tests for contact endpoints
 *
 * POST /contacts/register  — Register/update profile
 * GET  /contacts/me        — Get own profile
 * GET  /contacts/search    — Search contacts
 * GET  /contacts/:userId   — Get contact's public profile
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

const USER_A = "contact-user-a";
const USER_B = "contact-user-b";
const USER_C = "contact-user-c";

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
// Helper: register a contact
// ─────────────────────────────────────────────────────────────────────────────

async function registerContact(
  userId: string,
  overrides: Record<string, unknown> = {}
) {
  const token = await authHeader(userId);
  return request(app)
    .post("/contacts/register")
    .set("Authorization", token)
    .send({
      displayName: `User ${userId}`,
      ...overrides,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /contacts/register — Register/update profile
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /contacts/register", () => {
  it("registers a new contact profile", async () => {
    const res = await registerContact(USER_A, {
      displayName: "Alice",
      email: "alice@example.com",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBe(USER_A);
    expect(res.body.data.displayName).toBe("Alice");
    expect(res.body.data.email).toBe("alice@example.com");
    expect(res.body.data.tezAddress).toBe(`${USER_A}@localhost`);
    expect(res.body.data.status).toBe("active");
    expect(res.body.data.registeredAt).toBeDefined();
  });

  it("registers without optional fields", async () => {
    const res = await registerContact(USER_A, {
      displayName: "Alice",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.email).toBeNull();
    expect(res.body.data.avatarUrl).toBeNull();
  });

  it("updates an existing profile on re-registration", async () => {
    // First registration
    await registerContact(USER_A, {
      displayName: "Alice",
      email: "alice@example.com",
    });

    // Update
    const res = await registerContact(USER_A, {
      displayName: "Alice Updated",
      email: "alice-new@example.com",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.displayName).toBe("Alice Updated");
    expect(res.body.data.email).toBe("alice-new@example.com");
    // Should keep the same ID
    expect(res.body.data.id).toBe(USER_A);
  });

  it("returns 400 for missing displayName", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .post("/contacts/register")
      .set("Authorization", token)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for empty displayName", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .post("/contacts/register")
      .set("Authorization", token)
      .send({ displayName: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid email format", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .post("/contacts/register")
      .set("Authorization", token)
      .send({ displayName: "Alice", email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/contacts/register")
      .send({ displayName: "No Auth" });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /contacts/me — Get own profile
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /contacts/me", () => {
  it("returns own profile when registered", async () => {
    await registerContact(USER_A, {
      displayName: "Alice",
      email: "alice@example.com",
    });

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/me")
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(USER_A);
    expect(res.body.data.displayName).toBe("Alice");
    expect(res.body.data.email).toBe("alice@example.com");
  });

  it("returns 404 when not registered", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/me")
      .set("Authorization", token);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/contacts/me");

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /contacts/search — Search contacts
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /contacts/search", () => {
  it("searches contacts by display name", async () => {
    await registerContact(USER_A, { displayName: "Alice Anderson" });
    await registerContact(USER_B, { displayName: "Bob Builder" });
    await registerContact(USER_C, { displayName: "Alice Carter" });

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/search")
      .query({ q: "Alice" })
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.count).toBe(2);

    const names = res.body.data.map((c: { displayName: string }) => c.displayName);
    expect(names).toContain("Alice Anderson");
    expect(names).toContain("Alice Carter");
  });

  it("searches contacts by email", async () => {
    await registerContact(USER_A, {
      displayName: "Alice",
      email: "alice@example.com",
    });
    await registerContact(USER_B, {
      displayName: "Bob",
      email: "bob@example.com",
    });

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/search")
      .query({ q: "bob@" })
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].displayName).toBe("Bob");
  });

  it("respects limit parameter", async () => {
    await registerContact(USER_A, { displayName: "Test User A" });
    await registerContact(USER_B, { displayName: "Test User B" });
    await registerContact(USER_C, { displayName: "Test User C" });

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/search")
      .query({ q: "Test", limit: "2" })
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it("returns 400 for query shorter than 2 chars", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/search")
      .query({ q: "A" })
      .set("Authorization", token);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for empty query", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/search")
      .query({ q: "" })
      .set("Authorization", token);

    expect(res.status).toBe(400);
  });

  it("returns empty results for no match", async () => {
    await registerContact(USER_A, { displayName: "Alice" });

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/search")
      .query({ q: "Zzzzz" })
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .get("/contacts/search")
      .query({ q: "test" });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /contacts/:userId — Get contact's public profile
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /contacts/:userId", () => {
  it("returns public profile for another user", async () => {
    await registerContact(USER_B, {
      displayName: "Bob",
      email: "bob@example.com",
    });

    const token = await authHeader(USER_A);
    const res = await request(app)
      .get(`/contacts/${USER_B}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(USER_B);
    expect(res.body.data.displayName).toBe("Bob");
    expect(res.body.data.tezAddress).toBeDefined();
    expect(res.body.data.status).toBe("active");
    // Public profile should NOT include email
    expect(res.body.data.email).toBeUndefined();
  });

  it("returns 404 for non-existent contact", async () => {
    const token = await authHeader(USER_A);
    const res = await request(app)
      .get("/contacts/nonexistent-user")
      .set("Authorization", token);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/contacts/${USER_B}`);

    expect(res.status).toBe(401);
  });
});
