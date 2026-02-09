/**
 * Integration tests for team endpoints
 *
 * POST /teams              — Create team (creator becomes admin)
 * GET  /teams/:id/members  — List members (requires membership)
 * POST /teams/:id/members  — Add member (admin only)
 * DELETE /teams/:id/members/:userId — Remove member (admin or self-leave)
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

const ADMIN_USER = "user-admin-1";
const MEMBER_USER = "user-member-1";
const OUTSIDER_USER = "user-outsider-1";

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
// POST /teams — Create team
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /teams", () => {
  it("creates a team and makes the creator an admin", async () => {
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/teams")
      .set("Authorization", token)
      .send({ name: "Engineering" });

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.name).toBe("Engineering");
    expect(res.body.data.id).toBeDefined();

    // Verify creator is admin by listing members
    const teamId = res.body.data.id;
    const membersRes = await request(app)
      .get(`/teams/${teamId}/members`)
      .set("Authorization", token);

    expect(membersRes.status).toBe(200);
    expect(membersRes.body.data).toHaveLength(1);
    expect(membersRes.body.data[0].userId).toBe(ADMIN_USER);
    expect(membersRes.body.data[0].role).toBe("admin");
  });

  it("returns 400 for missing team name", async () => {
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/teams")
      .set("Authorization", token)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for empty team name", async () => {
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post("/teams")
      .set("Authorization", token)
      .send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app).post("/teams").send({ name: "No Auth" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 with invalid token", async () => {
    const res = await request(app)
      .post("/teams")
      .set("Authorization", "Bearer invalid-token")
      .send({ name: "Bad Token" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /teams/:id/members — List members
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /teams/:id/members", () => {
  it("lists all team members for a member", async () => {
    const { teamId, adminUserId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(MEMBER_USER);
    const res = await request(app)
      .get(`/teams/${teamId}/members`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);

    const userIds = res.body.data.map((m: { userId: string }) => m.userId);
    expect(userIds).toContain(ADMIN_USER);
    expect(userIds).toContain(MEMBER_USER);
  });

  it("returns 403 for non-members", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const token = await authHeader(OUTSIDER_USER);
    const res = await request(app)
      .get(`/teams/${teamId}/members`)
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 without auth", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const res = await request(app).get(`/teams/${teamId}/members`);

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /teams/:id/members — Add member (admin only)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /teams/:id/members", () => {
  it("admin can add a new member", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post(`/teams/${teamId}/members`)
      .set("Authorization", token)
      .send({ userId: MEMBER_USER, role: "member" });

    expect(res.status).toBe(201);
    expect(res.body.data.userId).toBe(MEMBER_USER);
    expect(res.body.data.role).toBe("member");

    // Verify member was added
    const membersRes = await request(app)
      .get(`/teams/${teamId}/members`)
      .set("Authorization", token);

    expect(membersRes.body.data).toHaveLength(2);
  });

  it("admin can add another admin", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post(`/teams/${teamId}/members`)
      .set("Authorization", token)
      .send({ userId: MEMBER_USER, role: "admin" });

    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe("admin");
  });

  it("non-admin member cannot add members", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(MEMBER_USER);
    const res = await request(app)
      .post(`/teams/${teamId}/members`)
      .set("Authorization", token)
      .send({ userId: OUTSIDER_USER, role: "member" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("non-member cannot add members", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const token = await authHeader(OUTSIDER_USER);
    const res = await request(app)
      .post(`/teams/${teamId}/members`)
      .set("Authorization", token)
      .send({ userId: "someone-else", role: "member" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("defaults role to member if not specified", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    const token = await authHeader(ADMIN_USER);

    const res = await request(app)
      .post(`/teams/${teamId}/members`)
      .set("Authorization", token)
      .send({ userId: MEMBER_USER });

    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe("member");
  });

  it("returns 401 without auth", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const res = await request(app)
      .post(`/teams/${teamId}/members`)
      .send({ userId: MEMBER_USER });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /teams/:id/members/:userId — Remove member
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /teams/:id/members/:userId", () => {
  it("admin can remove a member", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(ADMIN_USER);
    const res = await request(app)
      .delete(`/teams/${teamId}/members/${MEMBER_USER}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);

    // Verify member was removed
    const membersRes = await request(app)
      .get(`/teams/${teamId}/members`)
      .set("Authorization", token);

    expect(membersRes.body.data).toHaveLength(1);
    expect(membersRes.body.data[0].userId).toBe(ADMIN_USER);
  });

  it("member can self-leave", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);

    const token = await authHeader(MEMBER_USER);
    const res = await request(app)
      .delete(`/teams/${teamId}/members/${MEMBER_USER}`)
      .set("Authorization", token);

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);
  });

  it("non-admin cannot remove other members", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);
    await addMember(teamId, MEMBER_USER);
    const otherMember = "user-other-member";
    await addMember(teamId, otherMember);

    const token = await authHeader(MEMBER_USER);
    const res = await request(app)
      .delete(`/teams/${teamId}/members/${otherMember}`)
      .set("Authorization", token);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 without auth", async () => {
    const { teamId } = await createTeamWithAdmin(ADMIN_USER);

    const res = await request(app).delete(
      `/teams/${teamId}/members/${ADMIN_USER}`
    );

    expect(res.status).toBe(401);
  });
});
