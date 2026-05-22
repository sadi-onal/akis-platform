-- MCP OAuth client registrations (RFC 7591 Dynamic Client Registration).
-- One row per MCP server URL — the registration represents *AKIS* as a client,
-- shared across all end users. User-specific access/refresh tokens live in
-- oauth_accounts. This decouples DCR (boot-time, one-off) from the per-request
-- per-user OAuth flow.

CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"registration_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_clients_server_url_unique" UNIQUE("server_url")
);
