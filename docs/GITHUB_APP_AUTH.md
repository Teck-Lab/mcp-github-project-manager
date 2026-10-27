# GitHub App installation authentication

The stdio server can authenticate as a GitHub App installation without a PAT or
an interactive GitHub CLI login. All GitHub clients use Octokit's App auth
strategy, including milestone operations, standalone tools, and health checks.
Installation tokens are created and renewed by Octokit as requests require them;
the process and MCP connection do not need to restart when a token expires.

## Configuration

Set the repository context and all three App credentials:

```sh
GITHUB_OWNER=Teck-Lab
GITHUB_REPO=Teck.Monorepo
GITHUB_APP_ID=<app-id>
GITHUB_APP_INSTALLATION_ID=<installation-id>
GITHUB_APP_PRIVATE_KEY=<complete-PEM>
GH_CLI_TOKEN_FALLBACK=false
```

Leave `GITHUB_TOKEN` unset. A complete App configuration takes precedence if a
token is also configured. A partial App configuration is an error: the server
does not silently fall back to a personal token or `gh auth token`.

The PEM accepts real newlines or literal `\n` sequences. To use mounted secrets,
set `SECRETS_DIR=/run/secrets` and mount files named `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`. The existing secret
resolver reads those files before environment variables. Keep credentials out of
client-side MCP configuration; clients of a hosted gateway need only its bearer
key.

Install the App on the repositories it should reach. Repository Issues write
permission covers milestone creation and issue mutations. Organization Projects
write permission is needed for organization Project mutations. Grant other
permissions only for operations you enable. App authentication does not make
user-only GitHub endpoints available to an installation.

## MCPHub on Coolify

Build a pinned server revision with Node 24 and copy its `build/`, production
`node_modules/`, and `package.json` into the MCPHub image at
`/opt/github-project-manager`. The runtime requires Node 22.12 or later. Keep the
official GitHub MCP registered separately for existing clients.

Add a stdio server to MCPHub's settings:

```json
{
  "mcpServers": {
    "github-projects": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/github-project-manager/build/index.js"],
      "env": {
        "GITHUB_OWNER": "Teck-Lab",
        "GITHUB_REPO": "Teck.Monorepo",
        "GITHUB_APP_ID": "${GITHUB_APP_ID}",
        "GITHUB_APP_INSTALLATION_ID": "${GITHUB_APP_INSTALLATION_ID}",
        "GITHUB_APP_PRIVATE_KEY": "${GITHUB_APP_PRIVATE_KEY}",
        "GH_CLI_TOKEN_FALLBACK": "false",
        "MCP_TOOL_GROUPS": "core",
        "SYNC_ENABLED": "false",
        "SSE_ENABLED": "false",
        "AGENT_RECLAIM_ENABLED": "false",
        "CACHE_DIRECTORY": "/app/data/github-projects-cache"
      },
      "enabled": true
    }
  }
}
```

Provide the App variables as Coolify secrets to the MCPHub container. The settings
above contain placeholders, not the private key. Register this server on existing
persistent settings as well as new installations; replacing a seed template alone
does not update an existing MCPHub volume.

Clients connect to `https://<mcphub-host>/mcp/github-projects` using a MCPHub bearer
key authorized for that server. No additional public port is needed. The upstream
Compose port is for optional webhook/events functionality, not an HTTP MCP
transport. Milestones are managed with `manage_milestones` and its `action` field.

## Validation

The App-auth regression tests use generated test keys and mocked GitHub APIs.
They cover App-only startup validation, partial credentials, App precedence,
milestone operations through both service factories, standalone tool access,
renewal on the same client after token expiry, and preservation of PAT access.
The secret-provider tests ensure App deployments never borrow a personal CLI
credential. No live credentials are needed for these tests.

Before deploying, also exercise the built stdio server through your MCPHub
version, verify access in a dedicated test repository and rejection outside the
App installation, and confirm that existing GitHub MCP clients still connect.
