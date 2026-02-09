# tezit-relay

Open relay server for the [Tezit Protocol](https://github.com/tezit-protocol/spec). Securely deliver and persist context-rich messages for teams.

## What is a Tez?

A Tez is a message with an iceberg of context beneath it. When someone sends you a Tez, you see the surface ("Review the Q4 budget") but can dive into the depth: why they're asking, what led to this, who's involved, the actual documents, a voice note explaining the tricky part.

**tezit-relay handles the delivery and persistence. Your AI handles the context assembly.**

## The one thing this does

```
AI agent (OpenClaw, Claude, etc.)
  ↓ assembles context-rich message
tezit-relay
  ↓ persists, enforces team ACLs, delivers, audits
Recipient
  ↓ sees surface, explores depth, replies
```

## API

```
POST   /tez/share          Send a Tez (create + deliver)
GET    /tez/stream          Get feed for authenticated user
POST   /tez/:id/reply       Reply to a Tez (threaded)
GET    /tez/:id             Get full Tez with context + provenance
GET    /tez/:id/thread      Get full thread

POST   /teams               Create team
GET    /teams/:id/members   List members
POST   /teams/:id/members   Add member (admin)
DELETE /teams/:id/members/:userId  Remove member

GET    /health              Liveness check
```

## Quick start

```bash
git clone https://github.com/yourorg/tezit-relay.git
cd tezit-relay
cp .env.example .env
npm install
npm run dev
```

## Auth

tezit-relay does not manage users or passwords. It verifies JWTs from whatever auth system you use. Your JWT must contain a `sub` claim (user ID). Set `JWT_SECRET` in `.env`.

## Architecture

- **Express + TypeScript + Drizzle ORM + SQLite**
- Append-only audit log for every mutation
- Team ACLs enforced on every query and write
- No AI runtime, no billing, no federation — just messaging

## What's NOT in scope

- OpenClaw / AI runtime (that's your AI layer)
- User management / auth provider (bring your own)
- Federation between relay servers (future)
- Billing / entitlements (future)
- Standalone UI (that's the client's job)

## License

AGPL-3.0 — use it, self-host it, extend it. If you modify the server, share your changes.
