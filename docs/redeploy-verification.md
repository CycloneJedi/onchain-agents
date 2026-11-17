# Redeploy verification

Scope: read-only Base Sepolia displays, chain 84532.

## Nov 17, 2026 DeployDemoCharter redeploy

Current Breakaway addresses are the DeployDemoCharter redeploy from
CycloneJedi/mars2033 commit `5f2f3fea3007ef2935fb2f673b0060933b43148c`,
about 2:00 PM MT on Tue Nov 17, 2026. Deployer
`0x68ce334aC945dFd07DF9437886389150a5A41493`, nonces 404 to 437, blocks
60118252 to 60118262.

`eth_getCode` on `https://sepolia.base.org` returned code at each new address.
No transaction was sent. Reused addresses (geometry, sanctions, fee receiver)
also still have code. The work attestor remains an EOA with no code.

`eth_call` on the new auction returned `DEMO_RESERVE` of 50000000000000000 wei
(0.05 test ETH). `registry()`, `vault()`, and `charterRegistry()` returned the
new registry, vault, and CharterRegistry. The scheduler's `auction()` returned
the new auction. `getAuction(uint16)` and `getTileState(uint16)` still return
the shapes the live dashboard already decodes.

The Nov 11 record below is the prior redeploy. Its addresses are kept there as
that broadcast's record. They are not the current addresses.

## Prior Nov 11 record

The deployment-manifest.json confirms six current addresses: registry, claim,
auction, CharterRegistry, GovernanceRouter and scheduler. Vault and registration
are intentionally absent from that manifest. Their provenance is the Nov 11
Base Sepolia `DeployDemoCharter.s.sol` broadcast (`run-latest.json`) at redeploy
commit `2ea567259c509df0443eccfc5480ec28e0078d50`. Its archived redeploy record
and matching `broadcast/DeployDemoCharter.s.sol/84532/run-latest.json` are identical.

Both CREATE receipts have status `0x1` at block `0x36d9ace` (57514702):

- `DemoCharterVaultNext`: [0xE62Be8378830D2Fe9F4b4005f44B6348C06a0b22](https://sepolia.basescan.org/address/0xE62Be8378830D2Fe9F4b4005f44B6348C06a0b22),
  transaction [0xa797ec49e4ae9cf1e8fe4fe49fdf34916db5d7c20900c2dcc609e4d37feef88d](https://sepolia.basescan.org/tx/0xa797ec49e4ae9cf1e8fe4fe49fdf34916db5d7c20900c2dcc609e4d37feef88d).
- `DemoRegistration`: [0xDCD13dE3De8F2d3a551261FE905abdD2C10a4aE6](https://sepolia.basescan.org/address/0xDCD13dE3De8F2d3a551261FE905abdD2C10a4aE6),
  transaction [0x845037f41701e372aa8dee34c2bfe106f9e0a120b3b5e6fd7074955612a1e607](https://sepolia.basescan.org/tx/0x845037f41701e372aa8dee34c2bfe106f9e0a120b3b5e6fd7074955612a1e607).

The first receipt in that broadcast is RegistryNext at block `0x36d9ac9`
(57514697), transaction
[0x29a4a3e44a95ea9aefa02ff63ef5dccdaf01f374b93af2da9375633e0dbf4b6a](https://sepolia.basescan.org/tx/0x29a4a3e44a95ea9aefa02ff63ef5dccdaf01f374b93af2da9375633e0dbf4b6a).

The redeploy checkout is commit `2ea567259c509df0443eccfc5480ec28e0078d50`.
Its `contracts/script/DeployDemoCharter.s.sol` constants verify the shared treasury,
sanctions, geometry and work attestor addresses. These are reused, not new deployments.

ABI source: that checkout's `contracts/out/` build artifacts for RegistryNext,
DemoClaim, DemoCharterVaultNext, DemoCharterAuctionNext, DemoRegistration,
DemoScheduler, CharterRegistry and GovernanceRouter. The dashboard config and
ABI downloads use those artifacts. The frontend's getAuction, getTileState,
escheatCount, escheats and all eight event fragments match their input/output
types and event indexing. Full older ABIs were not identical to the new build;
the dashboard's existing getAuction, getTileState and counted event interfaces
remain compatible. Verification is against the repo build, not an independent
on-chain runtime bytecode comparison.

New addresses are used by read-only code. The dashboard keeps its existing
3000-block lookback; unused origin-block config was removed.

Fresh public RPC check: tile 60 reports seed and reserve 50000000000000000 wei
(0.05 test ETH), bidder `0x5E643c07D102f3D66EBbBb39BBd244F3abc5a554`.
The brief's 0.0625 figure does not match the observed bid. A frontend refresh
completed with 36 successful reads and zero failed reads. No writes were sent.
