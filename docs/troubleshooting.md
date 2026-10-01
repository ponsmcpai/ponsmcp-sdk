# Troubleshooting

## Tool does not appear

Confirm the MCP client starts `node /absolute/path/to/dist/mcp.js`, then restart the client so it performs MCP discovery again. The server's `tools/list` response should contain nine entries.

## `pons_balance` says no wallet configured

This tool needs `PONSMCP_PRIVATE_KEY` in the MCP subprocess environment. Do not add it to a frontend `.env` file. Check that the value is a 64-character hexadecimal private key.

## `pons_pay` is policy denied

Check `PONSMCP_MAX_PER_TX` and `PONSMCP_DAILY_LIMIT`. These values are base units, not human USDG. For example, 100 USDG is `100000000`.

## Receipt is pending

The transaction may still be pending or the wait window was too short. Call `pons_tx_status` using the returned hash. A receipt lookup must be made on Robinhood Chain.

## `pons_launch_info` reports not a readable launch token

The address may not be a pons v1 self-describing launch token, may be on the wrong network, or an RPC endpoint may be unavailable. Check the token address and try a known pons v1 token before assuming the tool has identified a launch.

## RPC problems

Set `PONSMCP_RPC_URL` to an operator-approved chain-4663 endpoint. Public endpoints can rate limit or be unavailable. The server will report an RPC error rather than return fabricated chain state.
