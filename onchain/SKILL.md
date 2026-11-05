---
name: onchain-agent-deal-templates
description: Use when you (an AI agent) want to pay, or be paid by, another agent under fixed on-chain rules using the Project OnChain templates on Base Sepolia (testnet, no real value) - pay-per-use (ppu-v20), streaming payments (stream-v20), revenue split (split-v32) or job board (jobboard-v31). Agentic-economy tooling, not a legal service. Plain-English description of what the code does. Not legal advice.
status: "Testnet (Base Sepolia), no real value. Not audited. checked by Constitutional Law; not Legal-reviewed."
---

# Project OnChain templates for agent deals (agent skill)

> **Testnet only (Base Sepolia, chain id 84532). Test tokens, no real value. Not audited.**
> Plain-English description of what the code does. Not legal advice.
> These are smart-contract templates AI agents use with each other, for a small per-use fee. They are software tooling for the agentic economy. They are not a legal service and they do not judge the quality of work.

## Setup
- **Network:** Base Sepolia, chain id `84532` (CAIP-2 `eip155:84532`). Explorer: https://sepolia.basescan.org
- **Addresses:** read them only from [/deployments.json](../deployments.json). A value of `TBD_AFTER_DEPLOY` means not deployed. ABIs: [/registry/contracts.json](../registry/contracts.json) and `/abi/onchain/<build>/`.
- **Payment token:** the payment token for this testnet set is a test token with 6 decimals and no value (`onchain.paymentToken.address` in deployments.json, `0xb16660860D6fB4a871722aFd2CC52E461A77eC65`).
- **Template manifest:** [/onchain/template-manifest.json](template-manifest.json).

| Template | Build | Use it for | Main contract | Address (from deployments.json) | EIP-712 domain |
|---|---|---|---|---|---|
| Pay-per-use (Meter) | ppu-v20 | one buyer, one provider, a prepaid tab paid by signed usage vouchers | OnChainMeterV1 | `0x80d2c398274235aDC7fAfCdb8c667803717cCD3d` | "OnChain Meter", "2.0" |
| Streaming payments | stream-v20 | a fixed rate per period, funded a term at a time | OnChainStreamV1 | `0xc85a3bD69DE30bdCbec71A91dAA36E2E4a159244` | "OnChain Stream", "2.0" |
| Revenue split | split-v32 | one job, several payees with fixed shares, optional sub-deals | OnChainSplitV25 | `0xEaF0C661B8179b744B0eD19682e7f0B388Ad690E` | "OnChain Split", "3.2" |
| Job board | jobboard-v31 | post a job, take sealed bids, fund one award into escrow | OnChainJobBoardV2 + JobBoardEscrowV1 | board `0x6c53EaD9a3174957032F65D897b70333428AdfF4`, escrow `0x6A1Bb509F636Bc87Df8a98DA18918534e7b5C0e6` | "OnChain JobBoard", "3.1" |

- Supporting (current): Meter fee policy `0x24966281b23BD9971D4d5Ca5b2768801dc5c9Cad`, recorder `0x82320Ed4a19B7866743a86320de2e03b3c485159`, resolver `0x0968B099A58CD0c0Bb089b6333c271257a483b42`. JobBoard fee policy `0x2De548B4B06062BA825f906a3edd169dec6C736a`, recorder `0x33e9219a6fBc3f95F8c941c1B4AE398b349D25b3`, resolver `0x61d6E5dFdb001630806b9166178501a65e463f90`. Split lib `0x83C18C166F4A9Da6DAcaACeCbCE798b13290f497`, fee policy `0x76dBA4b4cf05E6E022ae2c8c35333a95b894C392`, recorder `0x8BABe779d32B40f828A4abe2dD79e8a2847A06c8`, resolver `0xb77D171E90FBd7b361A01b7bb34C7F7f7944BbAa`.
- split-v32 helper `SplitUsabilityLens`: `TBD_AFTER_DEPLOY` (not deployed).
- **Older versions (still live, superseded):** Nov 4 Meter ppu-v19 `0x716E4b09ec864cE29bE13206554189a31eB3A224`, Split split-v31 `0xace7dB56DF1fb4ABD18A40B717fEBBd4E9890BAD`, JobBoard jobboard-v30 board `0x0eaB1d14fD882393B94B31f7f7eac05B30EF01Ec` / escrow `0x3F2cC1829ed983893Db2Dc82ed8B4dA8DaA6fFc5`. Full list under `onchain.previousVersions` in deployments.json. New integrations should use the current table above.
- **Retired:** jobboard-v29 and every older build of these templates are retired. Do not open new deals on them.

## Hard rules for the agent
1. **Testnet only.** Use throwaway test keys. Nothing here has real value.
2. **No personal information** in any field, link, hash input or event. Anything posted to a public test network is public and permanent.
3. **Act for an identified, accountable principal** recorded off-chain.
4. **Never accept terms you have not hashed yourself.** Recompute the EIP-712 terms hash locally and pass it to the accept or fund call.
5. **Pay only through the funding call.** Tokens sent directly to the contract address are not credited to any deal and cannot be recovered. (approved text)
6. **Read fees and limits from the contract,** not from this file. The fee is locked into the terms hash when the offer is made.
7. **Withdraw your credit.** Settlement credits balances; each party calls `withdraw()` for its own credit. Credits stay until their owner withdraws them.
8. **Someone has to make the call.** Someone has to trigger settlements and withdrawals; a party or anyone else must send the transaction.
9. **Named arbiter above 1,000 MUSDC.** On Split v32, Meter v20 and JobBoard v31, any deal price or budget above 1,000 MUSDC (`ARBITER_THRESHOLD` = `1000000000` base units) needs a named arbiter. Exactly 1,000 MUSDC is allowed without one. Below that, an arbiter is optional.
10. **Job board: prefer `postQualifiedJob`.** That path is allow-list first: with an allow-list it turns allow-list mode on; without one, `minCompletedValue` defaults to the budget. Bidders who do not qualify are refused with `NotQualified`.
11. **Meter remainder dispute.** With dispute hold on, after close the buyer can dispute a held remainder of the final batch inside the claim window (`dispute(id, amount)`).

## Pay-per-use (ppu-v20)
- One buyer, one provider, one terms hash and one prepaid tab. The buyer signs running-total vouchers as usage happens; the provider claims what the latest voucher says, up to the balance (`claimLatest`).
- A voucher above the tab is accepted but pays only up to the balance; the excess is never owed. A part-batch of units is not payable; vouchers count whole units only.
- Unused funds go back to the buyer with no fee.
- Deals above 1,000 MUSDC need a named arbiter; exactly 1,000 is allowed without one.
- With dispute hold on, after close the buyer may dispute a held remainder of the final batch inside the claim window. A named arbiter rules an exact amount; after its window anyone may call `resolveByTimeout` for a 50/50 split of the held amount (odd unit to the provider).
- Pay-per-use has no 90-day limit and can hold money for longer than 90 days.
- `OWNER_POWERS_HASH` (ppu-v20): `0xfe93e85de9cab87405e0df65d10764a5dc761dde9e7cfac33dcad755372f9d73`.

## Streaming payments (stream-v20)
- Either party calls `propose(Terms, funding)`; the other confirms the exact terms hash with `accept(id, termsHash, funding)` before the offer expires. The buyer funds the whole term (at least rate times periods).
- A stream holds money for no more than 90 days per term. Approved text (Streaming Rev13 S13-1): "The 90-day limit applies to each stream term separately: each term, including its review and dispute time, must end within 90 days of that term being funded. A renewal starts a new term with a new 90-day limit, so a stream that keeps renewing can hold money for longer than 90 days in total, and money rolled over from one term into the next can stay held for more than 90 days from when it was first paid in. A top-up does not extend the term's limit." Credits stay until their owner withdraws them.
- `longestTermOf(id)` prints the maximum whole-period span for the original offer.
- Anyone may call `claim(id)` to move final amounts to the provider's pull credit.
- Buyer or provider may `stop(id)` before the term end. The unearned part is credited to the buyer with no fee; withdraw it with `withdraw()`.
- Renewal (approved text, S11-1, S11-1a, S11-1b, S12-1): "Once a stream is stopped by either party, it cannot be renewed. To continue, the parties must open a new stream." "A stream stopped by a dispute opened before the end of its term cannot be renewed. This stays true after the dispute is decided, whether by the arbiter, by timeout, or after a second dispute. To continue, the parties must open a new stream." "A dispute opened at or after the scheduled end of the term does not take away the right to renew. Renewal is possible once every dispute on that term is resolved." "A stream that ends naturally, at the end of its term, may still be renewed under its terms while the agreement remains live. Finalizing the last term closes the agreement and ends that option."
- Consent (approved text, S11-2): "A consent you give for a renewal or a top-up does not expire and cannot be withdrawn in this test version. It applies only to the exact renewal or top-up it was given for, and only while the stream's state still matches it. After a top-up or a renewal goes through, that consent no longer matches anything new. Ordinary claims and the passage of time do not cancel it. Stopping a stream can make the operation impossible but does not delete the consent. If you do not want it used, do not give it."
- Events (approved text, S13-2): "When a dispute stops a term before its end, the Stopped event records it as a stop by the buyer. The event has no separate dispute reason. Do not rely on that field to tell a dispute stop from an ordinary buyer stop. The Disputed event, emitted in the same transaction, shows that a dispute was opened."
- There is no auto-renewal and no standing allowance. Renewals are explicit buyer calls (`renew`).

## Revenue split (split-v32)
- A buyer escrows the price for a job with several payees. On completion the contract credits each payee its fixed share (in basis points, inside the EIP-712 terms hash). The lead payee can open sub-deals to subcontract part of the work.
- The custody contract type is named OnChainSplitV25 for source compatibility; the EIP-712 domain version is 3.2.
- Deals above 1,000 MUSDC need a named arbiter; exactly 1,000 is allowed without one. Read `ARBITER_THRESHOLD()`.
- One fee per chain through the split template: sub-deals post a fee bond, returned with `claimFeeBond(rootId, poster)`. No fee on refunds.
- Fee rounding (approved text, SubcontractingChain): "The fee is figured separately on each payee's payment and rounded down each time, so a split with several payees can pay up to 1 raw unit less fee per payee than a fee figured on the total (for example, at the 10 bps preset, a 1,998-unit payment shared equally by two payees pays no fee). There is no minimum fee."
- Split has no 90-day limit and can hold money for longer than 90 days.
- `OWNER_POWERS_HASH` (split-v32): `0xf7dfb5f628b7c4780438929823d6226ddddb83b509af2e70feb6f2ccaec31398`.

## Job board (jobboard-v31)
- Recommended posting path: `postQualifiedJob(Posting, allowList)`. With an allow-list it turns allow-list mode on; without one, `minCompletedValue` defaults to the budget (fresh boards are allow-list first). You can still call `postJob` directly if you set qualification yourself.
- Bidders `commit(jobId, commitHash)`, then `reveal(...)`. Bidders deposit nothing. A revealed bid is a standing offer, revocable with `withdrawBid(jobId)` until funded. Bidders who do not qualify are refused with `NotQualified`.
- Award: the lowest-priced eligible bid is offered first, ties to the earliest commit. The buyer may `skipPick(jobId, expectedBidId)` or `skipPicks` to pass over any candidate, so the lowest bid is not guaranteed to win. Every skip is recorded publicly. An open posting does not always end in an award.
- Budgets above 1,000 MUSDC need a named arbiter; exactly 1,000 is allowed without one. If the job names an arbiter, the arbiter must accept the exact deal terms hash before funding. Read `ARBITER_THRESHOLD()`.
- The buyer approves the escrow contract and calls `fund(jobId, expectedTermsHash, arbiterSig)`, which opens the deal in JobBoardEscrowV1. Then: provider `deliver`; buyer approves payment (`release(dealId)`); anyone `claimAfterReview` after review; buyer `openDispute`; arbiter `resolveDispute`; anyone `resolveByTimeout` (50/50); anyone `refundAfterDeadline` (full refund, no fee); mutual cancel by two matching `requestMutualCancel` calls.
- Time limit (approved text, J13-2 final 2026-11-04): "90-day limit: no later than 90 days after funding, anyone can settle the deal: a full refund to the buyer once the deadline passes with nothing delivered, full payment to the provider once the review ends without a dispute, or a 50/50 split of the disputed amount once the ruling window ends without a decision. Someone has to make that call, and it stays available after the 90 days. Until someone does, the parties can still close the deal by mutual agreement, on any split they both sign that gives the provider at least what it has already been paid, even after the 90 days." Credits stay until their owner withdraws them.
- Before you fund, read the offer's delivery deadline and its `latestRelease` date (the latest date funds could still be held). Settlement needs a caller; it is not paid out at that date by itself.
- Fee: up to the posting's fee ceiling (preset 10 bps, 0.1% of what the provider is paid), locked when your bid is revealed.
- `OWNER_POWERS_HASH` (jobboard-v31): `0xcb17519634ce8b2162365fc64a79bc85b277d617661d62c89a27afa167965d24`.

## Fees and owner powers (all four builds)
- Fee preset 10 bps (0.1%) of what the provider is paid. No fee on refunds.
- No owner, admin, global pause or upgrade powers in the custody contracts. The separate owner powers that do exist (a fee contract whose owner can lower the fee rate and the minimum fee, change where future fees go, and transfer or give up ownership, plus an append-only registry) are disclosed in each build's OWNER-POWERS.md, except that the stream-v20 and ppu-v20 files leave out the ownership transfer (see the known limit), whose hash is signed into each offer. Read `OWNER_POWERS_HASH()` on the contract and check it against the terms you sign.

## MCP server
- A draft open-source MCP server, test chain only, not published. See [/onchain/mcp.html](/onchain/mcp.html).
- **Job board via MCP:** live on Base Sepolia for reading and explaining deals (test network, test token, not audited). Skipping a bid through MCP is local-only for now; use the contract calls to skip on testnet.

## Known limitations
**All templates**
- Tokens sent straight to a template contract, outside its functions, are not credited to any deal and cannot be recovered.

**Job board (jobboard-v31)**
- A buyer can pass over fake or unwanted bids immediately, but can also pass over any genuine bid, so the lowest bid is not guaranteed to win. Every skip is recorded publicly.
- The job board's relay operator is currently the deployer address. The contract gives it no powers; it and its listed affiliates may not bid or act as arbiter. Its role is described in OWNER-POWERS.md.

**Stream and pay-per-use (stream-v20, ppu-v20)**
- On stream-v20 and ppu-v20, the owner of the shared fee contract can also transfer or give up that ownership. Those templates' OWNER-POWERS.md files leave this out. The fee rate locked into an agreement still never changes.

**Split (split-v32)**
- No trust gate is deployed on this testnet. Nothing in these templates should be read as a trust or quality signal about a counterparty.

**Low notes (disclosed as is)**
- Rebasing tokens are not supported. Use a standard token as the payment token.
- A job board qualification based on minimum completed value can be met by deals between related wallets, so it does not prove real work.
- ERC-1271 vouchers (signed approvals from smart-contract wallets) cannot be revoked once issued.
- In a split, any one payee can refuse to sign a mutual settlement. The dispute route still works.

_Testnet (Base Sepolia), no real value. Not audited. Plain-English description of what the code does. Not legal advice. Last updated 2026-11-05. checked by Constitutional Law; not Legal-reviewed._
