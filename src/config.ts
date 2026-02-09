/**
 * tezit-relay configuration
 *
 * All settings from environment. No hardcoded product names.
 */

export const config = {
  port: parseInt(process.env.PORT || "3002", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  // Auth — pluggable JWT verification
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  jwtIssuer: process.env.JWT_ISSUER || "tezit-relay",

  // Limits
  maxTezSizeBytes: parseInt(process.env.MAX_TEZ_SIZE_BYTES || "1048576", 10),
  maxContextItems: parseInt(process.env.MAX_CONTEXT_ITEMS || "50", 10),
  maxRecipients: parseInt(process.env.MAX_RECIPIENTS || "100", 10),
} as const;
