# Redeploy verification

Scope: read-only Base Sepolia displays, chain 84532.

Source folder: `/workspace/breakaway/deploy/base-sepolia/redeploy-20261111-130925/`.
The manifest confirms registry, claim, auction, CharterRegistry, GovernanceRouter and scheduler.
Vault `0xE62Be8378830D2Fe9F4b4005f44B6348C06a0b22` and registration
`0xDCD13dE3De8F2d3a551261FE905abdD2C10a4aE6` are absent from that manifest.
They match the `DemoCharterVaultNext` and `DemoRegistration` CREATE entries in
`run-latest.json` and its matching `broadcast/DeployDemoCharter.s.sol/84532/run-latest.json`.
The first receipt is block `0x36d9ac9`, decimal 57514697.

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

The wallet launch gate and legacy wallet contract defaults are restored unchanged.
New addresses are used by read-only code. The dashboard keeps its existing
3000-block lookback; unused origin-block config was removed.

Fresh public RPC check: tile 60 reports seed and reserve 50000000000000000 wei
(0.05 test ETH), bidder `0x5E643c07D102f3D66EBbBb39BBd244F3abc5a554`.
The brief's 0.0625 figure does not match the observed bid. A frontend refresh
completed with 36 successful reads and zero failed reads. No writes were sent.
