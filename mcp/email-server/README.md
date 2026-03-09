# Email MCP Server (Skeleton)

This is a minimal MCP server that exposes email tools and routes them to provider connectors.
The connectors are stubs so you can add IMAP/SMTP (custom mailbox) and Microsoft Graph (Outlook)
without changing the MCP tool interface.

## Setup

1) Copy the example config:

```
cp mcp/email-server/config.example.json mcp/email-server/config.json
```

2) Fill in account ids, emails, and server hosts in `mcp/email-server/config.json`.
   - Optional IMAP fields: `drafts_folder`, `sent_folder`.

3) Provide credentials via environment variables. Each account uses a prefix derived from its id:

- `ACCOUNT_<ACCOUNT_ID>_USERNAME`
- `ACCOUNT_<ACCOUNT_ID>_PASSWORD`

Example for `id: "assistant"`:

```
export ACCOUNT_ASSISTANT_USERNAME="user@example.com"
export ACCOUNT_ASSISTANT_PASSWORD="..."
```

Outlook OAuth can use:

- `ACCOUNT_<ACCOUNT_ID>_OAUTH_ACCESS_TOKEN` (direct token), or
- the shared Postgres `oauth_tokens` table (preferred; created by the app's OAuth flow).

For the DB-backed flow, set these env vars in the app and MCP server:

- `OUTLOOK_CLIENT_ID`
- `OUTLOOK_CLIENT_SECRET`
- `OUTLOOK_TENANT_ID` (or `common`)
- `OUTLOOK_REDIRECT_URI` (used by the app callback)
- `OUTLOOK_SCOPES` (optional)
- `OUTLOOK_STATE_SECRET` (only needed by the app for OAuth state)
- `DATABASE_URL` (so the MCP server can read stored tokens)

Then open `http://localhost:3000/api/oauth/outlook/start?account_id=owner` (match the
`account_id` to your config) to authorize and store tokens in Postgres.

4) Run the server:

```
node mcp/email-server/server.mjs
```

Or after adding the npm script:

```
npm run mcp:email
```

## Notes

- The server uses stdio transport so it can be launched by an MCP client.
- No secrets are stored on disk.
- IMAP/SMTP and Outlook Graph connectors are wired; add OAuth config and credentials to use them.
- The Outlook connector will create `oauth_tokens` in Postgres if it does not exist.
- Suggested libraries: `imapflow` (IMAP), `nodemailer` (SMTP).

## Config override

You can point to a different config path:

```
MCP_EMAIL_CONFIG_PATH=/path/to/config.json node mcp/email-server/server.mjs
```
