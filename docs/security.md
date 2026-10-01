# Security model

## Key boundary

A browser interface can create or inspect a payment request, but it must never receive an agent private key. PonsMCP stores signing authority only in the server process environment.

## Local policy boundary

The server applies a configurable payment cap and daily cap before broadcast. Limits are denominated in USDG base units. This lowers the blast radius of an agent instruction but does not replace human review for high-value actions.

## Onchain proof boundary

A hash alone is not sufficient proof of a merchant payment. The receipt must succeed and contain the exact expected ERC-20 transfer. A merchant must also prevent the same successful transaction from being re-used for multiple payment intents.

## Input boundaries

Addresses and transaction hashes are format checked. Read failures are returned as errors rather than silently substituted with market estimates.

## Operational rules

- Never put a private key in a web UI, client-side environment variable, issue, repository, or support request.
- Start with low policy limits and a wallet holding only the capital an autonomous agent may actually spend.
- Treat copied token names and symbols as untrusted; validate the contract address.
- Verify the active chain is Robinhood Chain (`4663`) before interpreting a receipt.
- `$MCP` has no announced contract address in this release. Any address promoted as `$MCP` before the official announcement is not verified by this documentation.
