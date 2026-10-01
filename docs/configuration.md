# MCP configuration

PonsMCP is a stdio MCP server. The exact configuration format varies by client, but the server needs one executable command.

```json
{
  "mcpServers": {
    "ponsmcp": {
      "command": "node",
      "args": ["/absolute/path/to/ponsmcp/dist/mcp.js"],
      "env": {
        "PONSMCP_MAX_PER_TX": "100000000",
        "PONSMCP_DAILY_LIMIT": "1000000000"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Meaning |
|---|---:|---|
| `PONSMCP_PRIVATE_KEY` | only for wallet reads / payments | local agent signing key; 64 hex characters, optionally prefixed with `0x` |
| `PONSMCP_MAX_PER_TX` | no | maximum USDG base units for a single payment; default `100000000` (100 USDG) |
| `PONSMCP_DAILY_LIMIT` | no | local in-process daily USDG base-unit limit; default `1000000000` (1,000 USDG) |
| `PONSMCP_RPC_URL` | no | override the RPC endpoint used by the server |

USDG has six decimals. `1000000` base units equals `1 USDG`.

## Tool names

Every configured MCP client discovers the nine tool names exactly as listed in [tools.md](tools.md). A client should call `tools/list` after initialization instead of hard-coding a stale inventory.
