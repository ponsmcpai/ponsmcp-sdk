#!/usr/bin/env python3
"""Insert JSDoc blocks above every tool entry in the TOOLS array of mcp.ts."""
import re, sys

PATH = '/root/ponsmcp/src/mcp.ts'
src = open(PATH).read()

# tool name -> (summary, [param lines], example-args-json)
DOCS = {
 'pons_chain_info': ("Robinhood Chain network facts.",
   [], '{}'),
 'pons_price': ("Live PONS market snapshot via DexScreener.",
   [], '{}'),
 'pons_launch_info': ("Read a pons v1 launch token onchain: pool, supply, logo, description, socials.",
   ['token - pons launch-token contract address (0x…), required'],
   '{ "token": "0x…" }'),
 'pons_launch_market': ("Live DEX markets, price, and liquidity for a pons launch token.",
   ['token - pons launch-token contract address (0x…), required'],
   '{ "token": "0x…" }'),
 'pons_v2_launch': ("Read a pons v2 factory launch record (deployer, paired token, pool fee, supply). Read-only.",
   ['token - pons v2 launch-token address (0x…), required'],
   '{ "token": "0x…" }'),
 'pons_v2_snipe_tax': ("Read the decaying opening snipe tax (bps) a v2 curve would charge a recipient right now.",
   ['curve - pons v2 curve address (0x…), required',
    'recipient - wallet that would receive the buy (0x…), required'],
   '{ "curve": "0x…", "recipient": "0x…" }'),
 'pons_v2_quote_buy': ("Pure curve buy quote: tokens out, fee, tax, snipe tax, refund. No chain reads.",
   ['quoteIn - buy amount in wei (quote asset), required',
    'quoteReserve - quote-asset reserve in wei, required',
    'tokenReserve - token reserve in wei (base units), required',
    'sellable - sellable token supply in wei, required',
    'feeBps - protocol fee in basis points, required',
    'creatorTaxBps - creator tax in basis points, required',
    'rawSnipeBps - raw opening snipe tax in basis points, required'],
   '{ "quoteIn": "1000000000000000000", "quoteReserve": "…", "tokenReserve": "…", "sellable": "…", "feeBps": "100", "creatorTaxBps": "300", "rawSnipeBps": "5000" }'),
 'pons_v2_quote_sell': ("Pure curve sell quote: quote out, fee, tax, net proceeds. No chain reads.",
   ['tokensIn - tokens sold in wei (base units), required',
    'quoteReserve - quote-asset reserve in wei, required',
    'tokenReserve - token reserve in wei, required',
    'feeBps - protocol fee in basis points, required',
    'creatorTaxBps - creator tax in basis points, required'],
   '{ "tokensIn": "1000000", "quoteReserve": "…", "tokenReserve": "…", "feeBps": "100", "creatorTaxBps": "300" }'),
 'pons_escrow_balance': ("Claimable native ETH on the pons v2 fee escrow for a recipient. Read-only.",
   ['recipient - creator/fee-recipient address (0x…), required'],
   '{ "recipient": "0x…" }'),
 'pons_escrow_token_balance': ("Claimable ERC-20 balance on the v2 fee escrow (quote asset or buyback vest). Read-only.",
   ['recipient - recipient address (0x…), required',
    'token - quote asset or launch-token address (0x…), required'],
   '{ "recipient": "0x…", "token": "0x…" }'),
 'pons_launch_feed': ("Recent pons launches from the official v1 feed.",
   ['limit - how many launches to return, 1-50, optional (default 10)'],
   '{ "limit": 10 }'),
 'pons_token_info': ("ERC-20 metadata (name, symbol, decimals, total supply) for any token on Robinhood Chain.",
   ['token - token contract address (0x…), required'],
   '{ "token": "0x…" }'),
 'pons_balance': ("Agent wallet balance for a token (defaults to USDG). Requires PONSMCP_PRIVATE_KEY.",
   ['token - token address or ticker (USDG, PONS, NVDA, …), optional (default USDG)'],
   '{ "token": "USDG" }'),
 'pons_quote': ("Convert a USD amount into USDG base units (6 decimals). Quote only — nothing executes.",
   ['amountUsd - USD amount as a decimal string, e.g. "5.00", required'],
   '{ "amountUsd": "5.00" }'),
 'pons_pay': ("Execute an autonomous payment: policy check → USDG transfer → verified receipt. Requires PONSMCP_PRIVATE_KEY.",
   ['payTo - recipient address (0x…), required',
    'amountUsd - USD amount as a decimal string, e.g. "5.00", required',
    'waitMs - max ms to wait for the receipt, optional (default 30000)'],
   '{ "payTo": "0x…", "amountUsd": "2.50" }'),
 'pons_pay_resource': ("Fetch a 402-gated resource, parse its price, settle exactly that price with policy checks. Requires PONSMCP_PRIVATE_KEY.",
   ['url - http(s) URL of the 402-gated resource, required',
    'waitMs - max ms to wait for the receipt, optional (default 30000)'],
   '{ "url": "https://api.example.com/brief" }'),
 'pons_tx_status': ("Look up a transaction receipt: status, block, gas, decoded ERC-20 transfers.",
   ['txHash - transaction hash (0x…, 64 hex), required'],
   '{ "txHash": "0x…" }'),
 'x402_fetch': ("Fetch any URL with x402 auto-settlement: on a 402 with an X-PAYMENT requirement, pay exactly that price (policy-checked) and retry with the signed proof header. Requires PONSMCP_PRIVATE_KEY.",
   ['url - http(s) URL to fetch, required',
    'waitMs - max ms to wait for the settlement receipt, optional (default 30000)'],
   '{ "url": "https://api.example.com/premium-data" }'),
 'x402_discover': ("Probe a domain for x402 paid resources via /.well-known/x402 and /api/x402/manifest. Read-only.",
   ['domain - domain to probe, e.g. "api.example.com", required'],
   '{ "domain": "api.example.com" }'),
 'pons_stocks_list': ("All 19 tokenized stock tokens on Robinhood Chain with contract addresses.",
   [], '{}'),
 'pons_stock_price': ("Live DEX price, liquidity, and 24h change for a stock token.",
   ['ticker - stock ticker (e.g. NVDA) or 0x contract address, required'],
   '{ "ticker": "NVDA" }'),
 'pons_stock_info': ("On-chain metadata (name, symbol, supply) for a stock token.",
   ['ticker - stock ticker (e.g. NVDA) or 0x contract address, required'],
   '{ "ticker": "NVDA" }'),
 'pons_stocks_screen': ("Screen all 19 stock tokens with live DEX data; filter and rank. Slow (batch DexScreener).",
   ['minLiquidityUsd - minimum liquidity filter in USD, optional (default 0)',
    'gradeA - only return Grade A tokens (liq>$500, change>-50%), optional'],
   '{ "gradeA": true }'),
 'pons_graduated_launches': ("pons v1 launches that have graduated (reached their liquidity threshold).",
   ['limit - max feed entries to scan, optional (default 20, max 50)'],
   '{ "limit": 20 }'),
 'pons_launch_ranking': ("Rank recent launches by graduation, liquidity, or 24h change with signal tiers.",
   ['limit - launches to fetch from the feed before ranking, optional (default 20, max 50)',
    'sortBy - "graduation" | "liquidity" | "change24h", optional (default graduation)'],
   '{ "limit": 20, "sortBy": "graduation" }'),
 'pons_send_token': ("Send any ERC-20 token on Robinhood Chain with policy caps. Requires PONSMCP_PRIVATE_KEY.",
   ['to - recipient address (0x…), required',
    'token - token address or ticker (USDG, PONS, NVDA, …), required',
    'amount - human decimal amount, e.g. "5.00", required',
    'waitMs - max ms to wait for the receipt, optional (default 30000)'],
   '{ "to": "0x…", "token": "USDG", "amount": "5.00" }'),
 'pons_send_eth': ("Send native ETH (gas token) on Robinhood Chain. Caps: 0.01 ETH/tx, 0.1 ETH/day. Requires PONSMCP_PRIVATE_KEY.",
   ['to - recipient address (0x…), required',
    'amountEth - ETH amount as a decimal string, e.g. "0.001", required',
    'waitMs - max ms to wait for the receipt, optional (default 30000, clamped 120000)'],
   '{ "to": "0x…", "amountEth": "0.001" }'),
}

lines = src.split('\n')
out = []
i = 0
inserted = 0
while i < len(lines):
    line = lines[i]
    m = re.match(r"^    name: '([a-z_0-9]+)',$", line)
    if m and m.group(1) in DOCS:
        tool = m.group(1)
        # walk back: the entry opens with '  {' directly above (unless JSDoc already present)
        assert out and out[-1].strip() == '{', f'unexpected structure above {tool}: {out[-1]!r}'
        # skip if a JSDoc already terminates right above the '{'
        already = len(out) >= 2 and out[-2].strip().endswith('*/')
        out.pop()  # remove the '{' line; we re-add it after the JSDoc
        if not already:
            summary, params, example = DOCS[tool]
            doc = ['  /**']
            doc.append(f'   * {tool} — {summary}')
            doc.append('   *')
            if params:
                for p in params:
                    doc.append(f'   * @param {p}')
            else:
                doc.append('   * @param none - this tool takes no arguments')
            doc.append('   * @example tools/call request body:')
            doc.append(f'   * @example {{ "name": "{tool}", "arguments": {example} }}')
            doc.append('   */')
            out.extend(doc)
            inserted += 1
        out.append('  {')
    out.append(line)
    i += 1

new = '\n'.join(out)
names = re.findall(r"^    name: '([a-z_0-9]+)',", new, re.M)
assert len(names) == 27, f'tool count changed: {len(names)}'
open(PATH, 'w').write(new)
print(f'inserted {inserted} JSDoc blocks; tools={len(names)}')
