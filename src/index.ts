/**
 * tezit-relay
 *
 * Open relay server for the Tezit Protocol.
 * Does one thing: securely deliver and persist context-rich messages (Tez) for teams.
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig();

import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { tezRoutes } from "./routes/tez.js";
import { teamRoutes } from "./routes/teams.js";
import { contactRoutes } from "./routes/contacts.js";
import { conversationRoutes } from "./routes/conversations.js";
import { unreadRoutes } from "./routes/unread.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "tezit-relay", version: "0.1.0" });
});

// Core routes
app.use("/tez", tezRoutes);
app.use("/teams", teamRoutes);
app.use("/contacts", contactRoutes);
app.use("/conversations", conversationRoutes);
app.use("/unread", unreadRoutes);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Route not found` },
  });
});

app.listen(config.port, () => {
  console.log(`tezit-relay listening on port ${config.port}`);
});

export default app;
