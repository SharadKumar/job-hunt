# Creating the Career bot

Send the message below the line to the account's primary bot. It creates the
Career bot, saves its role as a private skill, and reports what it could and
could not do. Fill the two placeholders first:

- `<MCP URL>`: the harness's MCP endpoint (only `POST /mcp` is exposed).
- `<MCP BEARER>`: the Grok key's bearer token. Never commit it.

Private skills and connected apps are shared by every bot on a Grok account,
so the harness limits what the key can do (no record access, only its own
tools) rather than relying on which bot holds the connector.

---

Please set up a new bot for my contract-work pipeline.

1. Save a private skill named "career". Description: "Role of the Career bot. Use for anything about finding, qualifying, pursuing or running contract work through the job-hunt harness and its Twenty workspace." Instructions: everything between `===== CAREER SKILL =====` and `===== END CAREER SKILL =====`.
2. Create a bot named "Career". Send it: "You are the Career bot. Your standing role is the private skill 'career'. Follow it from now on."
3. Add a custom MCP server connector named "Career harness" with URL `<MCP URL>` and the header `Authorization: Bearer <MCP BEARER>`. If this account can't add a custom MCP server with a header, say exactly that and stop at this step.
4. Ask the Career bot to call the tool `brief` (or, if the connector lists no `brief` yet, list its tools and call `find_many_workspace_members` with `{"limit":1,"select":["id"]}`) and report the raw result in one line.
5. In the Career bot, create the routine in `routines.md` (name "Harness digest", webhook trigger), paused. Tell me its webhook URL; I'll take the key from the routine's settings myself.
6. Reply with: the bot, the skill, the connector (working or the exact error), the tool result, and the routine with its URL, each in one line.

===== CAREER SKILL =====
(paste SKILL.md from the line "# Career bot" to the end)
===== END CAREER SKILL =====
