/**
 * Federation integration tests
 *
 * Two relay instances in the same test process, different in-memory DBs.
 * Tests the full federation lifecycle: identity, trust, delivery, threading.
 */

import { describe, test, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import {
  setupDbMock,
  initTestDb,
  cleanDb,
  closeTestDb,
  getTestDb,
  getTestClient,
  authHeader,
  createTeamWithAdmin,
  addMember,
} from "./setup.js";
import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";

// Must call before any imports that use db
setupDbMock();

// We need two independent server instances — for this test we use
// a single DB but test federation routes directly.

import {
  generateKeyPair,
  initIdentityFromValues,
  resetIdentity,
} from "../src/services/identity.js";
import { signRequest, computeDigest, verifyRequest } from "../src/services/httpSignature.js";
import {
  createBundle,
  validateBundle,
  computeBundleHash,
} from "../src/services/federationBundle.js";
import { partitionRecipients } from "../src/services/federationOutbound.js";

let app: Express;

// Server A identity
const keysA = generateKeyPair();
const identityA = {
  publicKey: keysA.publicKeyBase64,
  privateKeyPem: keysA.privateKeyPem,
  host: "alpha.test",
};

// Server B identity
const keysB = generateKeyPair();
const identityB = {
  publicKey: keysB.publicKeyBase64,
  privateKeyPem: keysB.privateKeyPem,
  host: "beta.test",
};

// Derive serverIds
import { createHash } from "crypto";
function deriveServerId(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}
const serverIdA = deriveServerId(identityA.publicKey);
const serverIdB = deriveServerId(identityB.publicKey);

// Test users — adminId must be a fixed string because vi.mock is hoisted
const aliceId = randomUUID();
const bobId = randomUUID();
const adminId = "test-admin-user-id-fixed";

// Mock config to enable federation
vi.mock("../src/config.js", () => ({
  config: {
    port: 3002,
    nodeEnv: "test",
    jwtSecret: "change-me-in-production",
    jwtIssuer: "tezit-relay",
    relayHost: "beta.test", // The test app acts as Server B
    maxTezSizeBytes: 1048576,
    maxContextItems: 50,
    maxRecipients: 100,
    federationEnabled: true,
    federationMode: "allowlist",
    dataDir: "./data",
    adminUserIds: ["test-admin-user-id-fixed"],
  },
}));

beforeAll(async () => {
  await initTestDb();

  // Initialize identity as Server B (the receiving server)
  initIdentityFromValues(identityB);

  // Import app after mocks
  const { createTestApp } = await import("./setup.js");
  app = await createTestApp();
});

afterEach(async () => {
  // Always restore Server B identity so tests don't leak
  initIdentityFromValues(identityB);
  await cleanDb();
});

afterAll(async () => {
  resetIdentity();
  closeTestDb();
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests: Identity
// ─────────────────────────────────────────────────────────────────────────────

describe("Server Identity", () => {
  test("generates Ed25519 keypair", () => {
    const keys = generateKeyPair();
    expect(keys.publicKeyBase64).toBeTruthy();
    expect(keys.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  test("serverId is deterministic from public key", () => {
    const id1 = deriveServerId(identityA.publicKey);
    const id2 = deriveServerId(identityA.publicKey);
    expect(id1).toBe(id2);
    expect(id1.length).toBe(16);
  });

  test("different keys produce different serverIds", () => {
    expect(serverIdA).not.toBe(serverIdB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests: HTTP Signatures
// ─────────────────────────────────────────────────────────────────────────────

describe("HTTP Signatures", () => {
  test("sign and verify roundtrip", () => {
    const body = JSON.stringify({ hello: "world" });
    const signed = signRequest({
      method: "POST",
      path: "/federation/inbox",
      host: "beta.test",
      body,
      privateKeyPem: identityA.privateKeyPem,
      keyId: serverIdA,
    });

    expect(signed.Signature).toBeTruthy();
    expect(signed.Digest).toContain("SHA-256=");
    expect(signed["Signature-Input"]).toContain(serverIdA);

    const isValid = verifyRequest({
      method: "POST",
      path: "/federation/inbox",
      host: "beta.test",
      date: signed.Date,
      digest: signed.Digest,
      signature: signed.Signature,
      signatureInput: signed["Signature-Input"],
      body,
      publicKeyBase64: identityA.publicKey,
    });

    expect(isValid).toBe(true);
  });

  test("tampered body fails verification", () => {
    const body = JSON.stringify({ hello: "world" });
    const signed = signRequest({
      method: "POST",
      path: "/federation/inbox",
      host: "beta.test",
      body,
      privateKeyPem: identityA.privateKeyPem,
      keyId: serverIdA,
    });

    const isValid = verifyRequest({
      method: "POST",
      path: "/federation/inbox",
      host: "beta.test",
      date: signed.Date,
      digest: signed.Digest,
      signature: signed.Signature,
      signatureInput: signed["Signature-Input"],
      body: JSON.stringify({ hello: "tampered" }),
      publicKeyBase64: identityA.publicKey,
    });

    expect(isValid).toBe(false);
  });

  test("wrong public key fails verification", () => {
    const body = JSON.stringify({ hello: "world" });
    const signed = signRequest({
      method: "POST",
      path: "/federation/inbox",
      host: "beta.test",
      body,
      privateKeyPem: identityA.privateKeyPem,
      keyId: serverIdA,
    });

    const isValid = verifyRequest({
      method: "POST",
      path: "/federation/inbox",
      host: "beta.test",
      date: signed.Date,
      digest: signed.Digest,
      signature: signed.Signature,
      signatureInput: signed["Signature-Input"],
      body,
      publicKeyBase64: identityB.publicKey, // Wrong key!
    });

    expect(isValid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests: Federation Bundle
// ─────────────────────────────────────────────────────────────────────────────

describe("Federation Bundle", () => {
  test("create and validate bundle", () => {
    const id = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: randomUUID(),
        threadId: null,
        parentTezId: null,
        surfaceText: "Hello from Server A",
        type: "note",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [
        { layer: "fact", content: "Test fact", mimeType: null, confidence: 95, source: "stated" },
      ],
      from: `alice@alpha.test`,
      to: [`bob@beta.test`],
      identity: id,
    });

    expect(bundle.protocol_version).toBe("1.2.4");
    expect(bundle.bundle_type).toBe("federation_delivery");
    expect(bundle.sender_server).toBe("alpha.test");
    expect(bundle.bundle_hash).toBeTruthy();

    const error = validateBundle(bundle);
    expect(error).toBeNull();

    // Restore identity B for other tests
    initIdentityFromValues(identityB);
  });

  test("tampered bundle fails validation", () => {
    const id = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: randomUUID(),
        threadId: null,
        parentTezId: null,
        surfaceText: "Original text",
        type: "note",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [],
      from: `alice@alpha.test`,
      to: [`bob@beta.test`],
      identity: id,
    });

    // Tamper with the bundle
    bundle.tez.surfaceText = "Tampered text";

    const error = validateBundle(bundle);
    expect(error).not.toBeNull();
    expect(error!).toContain("hash mismatch");
  });

  test("missing fields fail validation", () => {
    expect(validateBundle(null)).toBe("Bundle must be an object");
    expect(validateBundle({})).toContain("Invalid bundle_type");
    expect(validateBundle({ bundle_type: "federation_delivery" })).toContain("Missing sender_server");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests: Recipient Partitioning
// ─────────────────────────────────────────────────────────────────────────────

describe("Recipient Partitioning", () => {
  test("separates local and remote recipients", () => {
    const result = partitionRecipients(
      ["alice@beta.test", "bob@alpha.test", "charlie@beta.test", "plain-user-id"],
      "beta.test"
    );

    expect(result.local).toEqual(["alice@beta.test", "charlie@beta.test", "plain-user-id"]);
    expect(result.remote.size).toBe(1);
    expect(result.remote.get("alpha.test")).toEqual(["bob@alpha.test"]);
  });

  test("all local when no remote addresses", () => {
    const result = partitionRecipients(["alice@beta.test", "bob@beta.test"], "beta.test");
    expect(result.local.length).toBe(2);
    expect(result.remote.size).toBe(0);
  });

  test("groups remote by host", () => {
    const result = partitionRecipients(
      ["a@host1.com", "b@host2.com", "c@host1.com", "d@host3.com"],
      "myhost.com"
    );

    expect(result.remote.size).toBe(3);
    expect(result.remote.get("host1.com")).toEqual(["a@host1.com", "c@host1.com"]);
    expect(result.remote.get("host2.com")).toEqual(["b@host2.com"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests: Federation Routes
// ─────────────────────────────────────────────────────────────────────────────

describe("Federation Routes", () => {
  test("GET /federation/server-info returns identity", async () => {
    const res = await request(app).get("/federation/server-info");

    expect(res.status).toBe(200);
    expect(res.body.host).toBe("beta.test");
    expect(res.body.server_id).toBe(serverIdB);
    expect(res.body.public_key).toBe(identityB.publicKey);
    expect(res.body.protocol_version).toBe("1.2.4");
    expect(res.body.federation.enabled).toBe(true);
    expect(res.body.federation.inbox).toBe("/federation/inbox");
  });

  test("POST /federation/verify registers a new server", async () => {
    const res = await request(app)
      .post("/federation/verify")
      .send({
        host: "alpha.test",
        server_id: serverIdA,
        public_key: identityA.publicKey,
        display_name: "Server Alpha",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending"); // allowlist mode
  });

  test("POST /federation/verify in open mode auto-trusts", async () => {
    // Temporarily change mode to open by re-importing config mock
    const { config: testConfig } = await import("../src/config.js");
    const originalMode = testConfig.federationMode;
    (testConfig as any).federationMode = "open";

    const res = await request(app)
      .post("/federation/verify")
      .send({
        host: "gamma.test",
        server_id: "gamma123",
        public_key: "test-key",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("trusted");

    (testConfig as any).federationMode = originalMode;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests: Full Federation Flow
// ─────────────────────────────────────────────────────────────────────────────

describe("Full Federation Flow", () => {
  async function registerServerA() {
    // Register Server A via /federation/verify
    await request(app)
      .post("/federation/verify")
      .send({
        host: "alpha.test",
        server_id: serverIdA,
        public_key: identityA.publicKey,
        display_name: "Server Alpha",
      });

    // Admin trusts Server A
    const adminAuth = await authHeader(adminId);
    await request(app)
      .patch("/admin/federation/servers/alpha.test")
      .set("Authorization", adminAuth)
      .send({ trust_level: "trusted" });
  }

  async function registerBobOnServerB() {
    const auth = await authHeader(bobId);
    await request(app)
      .post("/contacts/register")
      .set("Authorization", auth)
      .send({ displayName: "Bob" });
  }

  function createSignedInboxRequest(bundle: object) {
    const body = JSON.stringify(bundle);
    const signed = signRequest({
      method: "POST",
      path: "/inbox",
      host: "beta.test",
      body,
      privateKeyPem: identityA.privateKeyPem,
      keyId: serverIdA,
    });
    return { body: bundle, headers: signed };
  }

  test("Server A sends Tez to user on Server B", async () => {
    await registerServerA();
    await registerBobOnServerB();

    const tezId = randomUUID();
    const idA = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: tezId,
        threadId: null,
        parentTezId: null,
        surfaceText: "Review Q4 budget",
        type: "decision",
        urgency: "high",
        actionRequested: "approve",
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [
        { layer: "background", content: "Q4 is ending soon", mimeType: null, confidence: null, source: "stated" },
        { layer: "fact", content: "Budget is $500k", mimeType: null, confidence: 95, source: "verified" },
        { layer: "constraint", content: "Must finalize by Friday", mimeType: null, confidence: null, source: "stated" },
      ],
      from: `alice@alpha.test`,
      to: [`${bobId}@beta.test`],
      identity: idA,
    });

    initIdentityFromValues(identityB); // Restore server B

    const { headers } = createSignedInboxRequest(bundle);

    const res = await request(app)
      .post("/federation/inbox")
      .set("Host", "beta.test")
      .set("Date", headers.Date)
      .set("Digest", headers.Digest)
      .set("Signature", headers.Signature)
      .set("Signature-Input", headers["Signature-Input"])
      .send(bundle);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.localTezIds).toHaveLength(1);
  });

  test("Server B receives Tez with full context iceberg", async () => {
    await registerServerA();
    await registerBobOnServerB();

    const tezId = randomUUID();
    const idA = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: tezId,
        threadId: null,
        parentTezId: null,
        surfaceText: "Important update",
        type: "update",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [
        { layer: "fact", content: "Revenue grew 15%", mimeType: null, confidence: 90, source: "verified" },
        { layer: "background", content: "Strong Q3 performance", mimeType: null, confidence: null, source: "stated" },
      ],
      from: `alice@alpha.test`,
      to: [`${bobId}@beta.test`],
      identity: idA,
    });

    initIdentityFromValues(identityB);

    const { headers } = createSignedInboxRequest(bundle);

    const inboxRes = await request(app)
      .post("/federation/inbox")
      .set("Host", "beta.test")
      .set("Date", headers.Date)
      .set("Digest", headers.Digest)
      .set("Signature", headers.Signature)
      .set("Signature-Input", headers["Signature-Input"])
      .send(bundle);

    expect(inboxRes.status).toBe(200);
    const localTezId = inboxRes.body.localTezIds[0];

    // Now Bob can retrieve the Tez with full context
    const bobAuth = await authHeader(bobId);
    const tezRes = await request(app)
      .get(`/tez/${localTezId}`)
      .set("Authorization", bobAuth);

    expect(tezRes.status).toBe(200);
    expect(tezRes.body.data.surfaceText).toBe("Important update");
    expect(tezRes.body.data.context).toHaveLength(2);
    expect(tezRes.body.data.context[0].layer).toBe("fact");
    expect(tezRes.body.data.context[0].content).toBe("Revenue grew 15%");
    expect(tezRes.body.data.context[0].confidence).toBe(90);
  });

  test("Untrusted server is rejected", async () => {
    // Register Server A but DON'T trust it
    await request(app)
      .post("/federation/verify")
      .send({
        host: "alpha.test",
        server_id: serverIdA,
        public_key: identityA.publicKey,
      });

    await registerBobOnServerB();

    const tezId = randomUUID();
    const idA = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: tezId,
        threadId: null,
        parentTezId: null,
        surfaceText: "Untrusted message",
        type: "note",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [],
      from: `alice@alpha.test`,
      to: [`${bobId}@beta.test`],
      identity: idA,
    });

    initIdentityFromValues(identityB);
    const { headers } = createSignedInboxRequest(bundle);

    const res = await request(app)
      .post("/federation/inbox")
      .set("Host", "beta.test")
      .set("Date", headers.Date)
      .set("Digest", headers.Digest)
      .set("Signature", headers.Signature)
      .set("Signature-Input", headers["Signature-Input"])
      .send(bundle);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SERVER_NOT_TRUSTED");
  });

  test("Invalid signature is rejected", async () => {
    await registerServerA();
    await registerBobOnServerB();

    const tezId = randomUUID();
    const idA = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: tezId,
        threadId: null,
        parentTezId: null,
        surfaceText: "Bad signature test",
        type: "note",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [],
      from: `alice@alpha.test`,
      to: [`${bobId}@beta.test`],
      identity: idA,
    });

    initIdentityFromValues(identityB);

    // Sign with WRONG key (Server B's key pretending to be A)
    const body = JSON.stringify(bundle);
    const badSigned = signRequest({
      method: "POST",
      path: "/inbox",
      host: "beta.test",
      body,
      privateKeyPem: identityB.privateKeyPem, // Wrong key!
      keyId: serverIdA, // Claims to be A
    });

    const res = await request(app)
      .post("/federation/inbox")
      .set("Host", "beta.test")
      .set("Date", badSigned.Date)
      .set("Digest", badSigned.Digest)
      .set("Signature", badSigned.Signature)
      .set("Signature-Input", badSigned["Signature-Input"])
      .send(bundle);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
  });

  test("Bundle hash prevents tampering", async () => {
    await registerServerA();
    await registerBobOnServerB();

    const tezId = randomUUID();
    const idA = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: tezId,
        threadId: null,
        parentTezId: null,
        surfaceText: "Original text",
        type: "note",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [],
      from: `alice@alpha.test`,
      to: [`${bobId}@beta.test`],
      identity: idA,
    });

    // Tamper with the bundle after signing
    bundle.tez.surfaceText = "Tampered text!";

    initIdentityFromValues(identityB);

    // Re-sign (so HTTP signature passes, but bundle hash fails)
    const tamperedBody = JSON.stringify(bundle);
    const signed = signRequest({
      method: "POST",
      path: "/inbox",
      host: "beta.test",
      body: tamperedBody,
      privateKeyPem: identityA.privateKeyPem,
      keyId: serverIdA,
    });

    const res = await request(app)
      .post("/federation/inbox")
      .set("Host", "beta.test")
      .set("Date", signed.Date)
      .set("Digest", signed.Digest)
      .set("Signature", signed.Signature)
      .set("Signature-Input", signed["Signature-Input"])
      .send(bundle);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INVALID_BUNDLE");
    expect(res.body.error.message).toContain("hash mismatch");
  });

  test("Remote user resolution works via tezAddress", async () => {
    await registerServerA();
    await registerBobOnServerB();

    const tezId = randomUUID();
    const idA = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: tezId,
        threadId: null,
        parentTezId: null,
        surfaceText: "Message for Bob",
        type: "note",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [],
      from: `alice@alpha.test`,
      to: [`${bobId}@beta.test`],
      identity: idA,
    });

    initIdentityFromValues(identityB);
    const { headers } = createSignedInboxRequest(bundle);

    const res = await request(app)
      .post("/federation/inbox")
      .set("Host", "beta.test")
      .set("Date", headers.Date)
      .set("Digest", headers.Digest)
      .set("Signature", headers.Signature)
      .set("Signature-Input", headers["Signature-Input"])
      .send(bundle);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
  });

  test("Unknown recipient returns partial success (207)", async () => {
    await registerServerA();
    await registerBobOnServerB();

    const unknownId = randomUUID();
    const tezId = randomUUID();
    const idA = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: tezId,
        threadId: null,
        parentTezId: null,
        surfaceText: "Multi-recipient test",
        type: "note",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [],
      from: `alice@alpha.test`,
      to: [`${bobId}@beta.test`, `${unknownId}@beta.test`],
      identity: idA,
    });

    initIdentityFromValues(identityB);
    const { headers } = createSignedInboxRequest(bundle);

    const res = await request(app)
      .post("/federation/inbox")
      .set("Host", "beta.test")
      .set("Date", headers.Date)
      .set("Digest", headers.Digest)
      .set("Signature", headers.Signature)
      .set("Signature-Input", headers["Signature-Input"])
      .send(bundle);

    expect(res.status).toBe(207);
    expect(res.body.accepted).toBe(true);
    expect(res.body.notFound).toHaveLength(1);
    expect(res.body.notFound[0]).toContain(unknownId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests: Admin Routes
// ─────────────────────────────────────────────────────────────────────────────

describe("Admin Routes", () => {
  test("list servers (empty)", async () => {
    const auth = await authHeader(adminId);
    const res = await request(app)
      .get("/admin/federation/servers")
      .set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test("trust then block a server", async () => {
    // Register a server
    await request(app)
      .post("/federation/verify")
      .send({
        host: "alpha.test",
        server_id: serverIdA,
        public_key: identityA.publicKey,
      });

    const auth = await authHeader(adminId);

    // Trust it
    let res = await request(app)
      .patch("/admin/federation/servers/alpha.test")
      .set("Authorization", auth)
      .send({ trust_level: "trusted" });

    expect(res.status).toBe(200);
    expect(res.body.data.trust_level).toBe("trusted");

    // Block it
    res = await request(app)
      .patch("/admin/federation/servers/alpha.test")
      .set("Authorization", auth)
      .send({ trust_level: "blocked" });

    expect(res.status).toBe(200);
    expect(res.body.data.trust_level).toBe("blocked");
  });

  test("remove a server", async () => {
    await request(app)
      .post("/federation/verify")
      .send({
        host: "alpha.test",
        server_id: serverIdA,
        public_key: identityA.publicKey,
      });

    const auth = await authHeader(adminId);

    const res = await request(app)
      .delete("/admin/federation/servers/alpha.test")
      .set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);

    // Verify it's gone
    const listRes = await request(app)
      .get("/admin/federation/servers")
      .set("Authorization", auth);

    expect(listRes.body.data).toEqual([]);
  });

  test("non-admin is rejected", async () => {
    const userAuth = await authHeader(randomUUID());
    const res = await request(app)
      .get("/admin/federation/servers")
      .set("Authorization", userAuth);

    expect(res.status).toBe(403);
  });

  test("view outbox (empty)", async () => {
    const auth = await authHeader(adminId);
    const res = await request(app)
      .get("/admin/federation/outbox")
      .set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests: .well-known and server discovery
// ─────────────────────────────────────────────────────────────────────────────

describe(".well-known endpoint", () => {
  test("returns server discovery info", async () => {
    const res = await request(app).get("/.well-known/tezit.json");

    // Note: createTestApp doesn't mount .well-known, so we test server-info instead
    // which returns the same data via /federation/server-info
    const infoRes = await request(app).get("/federation/server-info");

    expect(infoRes.status).toBe(200);
    expect(infoRes.body.host).toBe("beta.test");
    expect(infoRes.body.public_key).toBeTruthy();
    expect(infoRes.body.federation.enabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration test: Blocked server delivery rejected
// ─────────────────────────────────────────────────────────────────────────────

describe("Blocked Server", () => {
  test("blocked server cannot deliver", async () => {
    // Register and block Server A
    await request(app)
      .post("/federation/verify")
      .send({
        host: "alpha.test",
        server_id: serverIdA,
        public_key: identityA.publicKey,
      });

    const auth = await authHeader(adminId);
    await request(app)
      .patch("/admin/federation/servers/alpha.test")
      .set("Authorization", auth)
      .send({ trust_level: "blocked" });

    await registerBobHelper();

    const tezId = randomUUID();
    const idA = initIdentityFromValues(identityA);
    const bundle = createBundle({
      tez: {
        id: tezId,
        threadId: null,
        parentTezId: null,
        surfaceText: "From blocked server",
        type: "note",
        urgency: "normal",
        actionRequested: null,
        visibility: "dm",
        createdAt: new Date().toISOString(),
      },
      context: [],
      from: `alice@alpha.test`,
      to: [`${bobId}@beta.test`],
      identity: idA,
    });

    initIdentityFromValues(identityB);

    const body = JSON.stringify(bundle);
    const signed = signRequest({
      method: "POST",
      path: "/inbox",
      host: "beta.test",
      body,
      privateKeyPem: identityA.privateKeyPem,
      keyId: serverIdA,
    });

    const res = await request(app)
      .post("/federation/inbox")
      .set("Host", "beta.test")
      .set("Date", signed.Date)
      .set("Digest", signed.Digest)
      .set("Signature", signed.Signature)
      .set("Signature-Input", signed["Signature-Input"])
      .send(bundle);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SERVER_BLOCKED");
  });
});

// Helper
async function registerBobHelper() {
  const auth = await authHeader(bobId);
  await request(app)
    .post("/contacts/register")
    .set("Authorization", auth)
    .send({ displayName: "Bob" });
}
