import {readFileSync} from 'node:fs';
import {decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, toBytes} from 'viem';

globalThis.LIVE_DASHBOARD_TEST = true;
const dash = await import('../live/dashboard.mjs');

const {
  REQUEST_BUDGET,
  SECTION_RESERVES,
  LOG_LOOKBACK,
  REORG_DEPTH,
  refresh,
  contractLabel,
  setRequestGap,
  setRetryDelay,
  setIdCap,
  currentIdCap,
  budgetUsage,
  resetLogCache,
  logCoverage,
  useConfig,
  discardAboveHead,
  commitLogPage,
  visibleLogs,
  planEventReads,
  seedLogCache,
  armTestBudget,
  openSection,
  enqueueRpc,
  readLogWindow,
} = dash;

const cfg = JSON.parse(readFileSync(new URL('../live/config.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../live/dashboard.mjs', import.meta.url), 'utf8');
const ZERO = '0x0000000000000000000000000000000000000000';
const MULTICALL_ABI = [{
  type: 'function',
  name: 'aggregate3',
  stateMutability: 'view',
  inputs: [{
    name: 'calls',
    type: 'tuple[]',
    components: [
      {name: 'target', type: 'address'},
      {name: 'allowFailure', type: 'bool'},
      {name: 'callData', type: 'bytes'},
    ],
  }],
  outputs: [{
    name: 'returnData',
    type: 'tuple[]',
    components: [
      {name: 'success', type: 'bool'},
      {name: 'payload', type: 'bytes'},
    ],
  }],
}];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function zeroFor(input) {
  const type = input.type;
  if (type.endsWith('[]')) return [];
  if (type.startsWith('uint') || type.startsWith('int')) return 0n;
  if (type === 'bool') return false;
  if (type === 'address') return ZERO;
  if (type === 'bytes') return '0x';
  if (type.startsWith('bytes')) return '0x' + '00'.repeat(Number(type.slice(5)));
  if (type === 'tuple') {
    const value = {};
    for (const component of input.components) value[component.name || 'field'] = zeroFor(component);
    return value;
  }
  throw new Error('Unsupported ABI type ' + type);
}

function installDom() {
  class Elem {
    constructor() {
      this.textContent = '';
      this.className = '';
      this.disabled = false;
      this.children = [];
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
  }
  globalThis.Node = Elem;
  const slots = new Map();
  const slot = (key) => {
    if (!slots.has(key)) slots.set(key, new Elem());
    return slots.get(key);
  };
  globalThis.document = {
    visibilityState: 'visible',
    hidden: false,
    addEventListener() {},
    createElement() { return new Elem(); },
    createTextNode(text) {
      const node = new Elem();
      node.textContent = text;
      return node;
    },
    querySelector(selector) { return slot(selector); },
    getElementById(id) { return slot('#' + id); },
  };
  return {
    text(selector) { return slot(selector).textContent; },
  };
}

function installRpc(box) {
  const abiByAddress = {};
  for (const [name, address] of Object.entries(cfg.addresses)) {
    abiByAddress[address.toLowerCase()] = cfg.abis[name];
  }
  const seen = new Set();
  let rpcCount = 0;
  let ethCalls = 0;
  let counts = {};
  let ranges = [];
  const calls = [];
  const flags = {failBalances: false, calm: false};

  function rpcResult(result) {
    return {ok: true, status: 200, async text() { return JSON.stringify({jsonrpc: '2.0', id: 1, result}); }};
  }

  function rpcError(error, status = 200) {
    return {ok: status === 200, status, async text() { return JSON.stringify({jsonrpc: '2.0', id: 1, error}); }};
  }

  function once(key) {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  function encodeInner(target, data) {
    const abi = abiByAddress[target.toLowerCase()];
    const decoded = decodeFunctionData({abi, data});
    const fn = abi.find((item) => item.type === 'function' && item.name === decoded.functionName);
    let result = fn.outputs.length === 1 ? zeroFor(fn.outputs[0]) : fn.outputs.map((output) => zeroFor(output));
    if (flags.failFunctions && flags.failFunctions.has(target.toLowerCase() + ':' + decoded.functionName)) return {fail: true};
    if (decoded.functionName === 'nextJobId' || decoded.functionName === 'nextId') result = currentIdCap() + 1n;
    if (decoded.functionName === 'getAuction') {
      const tile = Number(decoded.args[0]);
      if (flags.failAuctions && flags.failAuctions.has(tile)) return {fail: true};
      const custom = flags.auctionByTile && (flags.auctionByTile[tile] || flags.auctionByTile[String(tile)]);
      if (custom) result = [BigInt(custom.endTime), custom.highestBidder, BigInt(custom.seed), BigInt(custom.reserve)];
    }
    const payload = encodeFunctionResult({abi, functionName: decoded.functionName, result});
    return payload;
  }

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('stats.json')) return {ok: false, status: 404, async text() { return ''; }};
    const body = JSON.parse(options.body);
    rpcCount += 1;
    counts[body.method] = (counts[body.method] || 0) + 1;
    calls.push(body.method);
    if (body.method === 'eth_chainId') return rpcResult('0x14a34');
    if (body.method === 'eth_blockNumber') return rpcResult('0x' + box.n.toString(16));
    if (body.method === 'eth_getBlockByNumber') {
      const blockNo = BigInt(body.params[0]);
      const ts = flags.timestampFor ? flags.timestampFor(blockNo) : 100n;
      return rpcResult({timestamp: '0x' + BigInt(ts).toString(16)});
    }
    if (body.method === 'eth_getBalance') {
      if (flags.failBalances) return rpcError({code: -32000, message: 'balance unavailable'});
      if (!flags.calm && once('balance')) return rpcError({code: -32007, message: 'too many requests'}, 429);
      return rpcResult('0x1');
    }
    if (body.method === 'eth_getLogs') {
      const from = BigInt(body.params[0].fromBlock);
      const to = BigInt(body.params[0].toBlock);
      ranges.push([from, to]);
      const key = from + ':' + to;
      if (!flags.calm && once('log429:' + key)) return rpcError({code: -32007, message: 'too many requests'}, 429);
      if (to - from + 1n > 100n) return rpcError({code: -32005, message: 'query returned more than 10000 results'});
      const extras = [];
      for (const item of flags.extraLogs || []) {
        const blockNo = BigInt(item.blockNumber);
        if (blockNo >= from && blockNo <= to) extras.push(item);
      }
      return rpcResult([{
        address: flags.activityAddress || cfg.addresses.JB,
        blockNumber: body.params[0].toBlock,
        logIndex: '0x0',
        transactionHash: '0x' + to.toString(16).padStart(64, '0'),
        data: '0x',
        topics: ['0x' + '11'.repeat(32)],
      }, ...extras]);
    }
    if (body.method === 'eth_call') {
      ethCalls += 1;
      if (ethCalls === 2) return rpcError({code: -32000, message: 'response too large'});
      const decoded = decodeFunctionData({abi: MULTICALL_ABI, data: body.params[0].data});
      const rows = decoded.args[0].map((call) => {
        const inner = encodeInner(call.target, call.callData);
        if (inner && typeof inner === 'object' && inner.fail) return {success: false, payload: '0x'};
        return {success: true, payload: inner};
      });
      return rpcResult(encodeFunctionResult({abi: MULTICALL_ABI, functionName: 'aggregate3', result: rows}));
    }
    throw new Error('Unexpected RPC method ' + body.method);
  };

  return {
    begin() {
      rpcCount = 0;
      ethCalls = 0;
      counts = {};
      ranges = [];
    },
    get rpcCount() { return rpcCount; },
    get calls() { return calls; },
    get counts() { return counts; },
    get ranges() { return ranges; },
    flags,
  };
}

function log(blockNumber, transactionHash) {
  return {blockNumber, transactionHash, logIndex: 0n, address: ZERO, data: '0x', topics: []};
}

function applyHead(state, head, replacement) {
  let next = discardAboveHead(state, head);
  const plan = planEventReads(next, head);
  for (const [start, end] of plan.pages) {
    const page = replacement.filter((item) => item.blockNumber >= start && item.blockNumber <= end);
    const committed = commitLogPage(next, start, end, page);
    assert(committed.ok, 'rollback page did not join coverage');
    next = committed.state;
  }
  return {state: next, pages: plan.pages};
}

const reserveTotal = Object.values(SECTION_RESERVES).reduce((sum, value) => sum + value, 0);
assert(reserveTotal === REQUEST_BUDGET, 'section reserves must add up to the hard cap');
assert(source.includes('Chain panels read the public RPC separately'), 'runner fallback text missing');
assert(!source.includes('Chain panels remain live'), 'old runner fallback is still present');
assert(!source.includes('eth_sendRawTransaction'), 'dashboard source mentions a transaction send');
assert(source.includes('No contract events in the covered blocks'), 'empty event wording missing');
assert(!source.includes('\u2014') && !source.includes('\u2013'), 'dashboard source has a dash that is not allowed');

const directory = cfg.directory || [];
function listed(address) {
  return directory.find((item) => item.address.toLowerCase() === address.toLowerCase());
}
const currentBoard = listed('0x24e18B482CA215b5e85E0F375380301D13e61dEc');
const olderBoard = listed('0x6c53EaD9a3174957032F65D897b70333428AdfF4');
assert(currentBoard && currentBoard.status === 'older' && currentBoard.abiKey === 'JB', 'JobBoard v32 is not marked older');
assert(olderBoard && olderBoard.status === 'older', 'JobBoard v31 is not marked older');
const v32Escrow = listed(cfg.addresses.ESC);
assert(v32Escrow && v32Escrow.status === 'older' && v32Escrow.name === 'Job escrow, v32 set' && v32Escrow.abiKey === 'ESC', 'v32 escrow row drifted');
for (const address of ['0x076167Ee9FF648087eA621B4eBEC1095eF2a74d0', '0x219A418F27802F21EA509f8356c7d06c74323Cf0', '0xB2e2C5FEbAc5eBF63b0DbbC6A2CD5c58433594Fc']) {
  const row = listed(address);
  assert(row && row.status === 'older' && row.name.startsWith('JobBoard v32'), address + ' is not an older v32 row');
}
assert(cfg.addresses.JB.toLowerCase() === '0x24e18b482ca215b5e85e0f375380301d13e61dec', 'live reads are not on JobBoard v32');
assert(cfg.addresses.ESC.toLowerCase() === '0x85c12b6ba25fc8fd2b054aa4ba6df4d788c3bba7', 'live reads are not on the v32 escrow');
assert(cfg.addresses.JB33 === '0x28Eb3B4684931cA32e3E6cBf7F4664B661d564A7', 'JB33 address drifted');
assert(cfg.addresses.ESC33 === '0xAB1c23EA94324731a89c8AA158555084dc236A88', 'ESC33 address drifted');
assert(cfg.addresses.JB33_FEE === '0x2f358Cc9E8601FD6eA7e2ab8d49744965a70ccA4', 'v33 fee address drifted');
assert(cfg.addresses.JB33_RECORDER === '0x10606daa9f9d12670Df50C5c5E717D64ce3269a4', 'v33 recorder address drifted');
assert(cfg.addresses.JB33_RESOLVER === '0x06272057b0Dfb22a17490576BBf9D1e4cb830adc', 'v33 resolver address drifted');
assert(cfg.addresses.JB33_REGISTRY === '0xB2932054908BB016291429fbE8591Ae2cCBE9Efd', 'v33 registry address drifted');
assert(cfg.labels.JB === 'JobBoard v32', 'v32 label changed');
assert(cfg.labels.ESC === 'Job escrow, v32 set', cfg.labels.ESC);
assert(cfg.labels.JB33 === 'JobBoard v33', cfg.labels.JB33);
assert(cfg.labels.ESC33 === 'Job escrow, v33 set', cfg.labels.ESC33);
const v33Board = listed(cfg.addresses.JB33);
const v33Escrow = listed(cfg.addresses.ESC33);
assert(v33Board && v33Board.status === 'current' && v33Board.abiKey === 'JB33' && v33Board.name === 'JobBoard v33', 'JobBoard v33 is not a current directory row');
assert(v33Escrow && v33Escrow.status === 'current' && v33Escrow.abiKey === 'ESC33' && v33Escrow.name === 'Job escrow, v33 set', 'v33 escrow is not current');
for (const address of [cfg.addresses.JB33_FEE, cfg.addresses.JB33_RECORDER, cfg.addresses.JB33_RESOLVER, cfg.addresses.JB33_REGISTRY]) {
  assert(listed(address)?.status === 'current', address + ' is not current');
}
const onchainNames = directory.filter((item) => item.group === 'Project OnChain').map((item) => item.name);
const v32At = onchainNames.indexOf('JobBoard v32');
const v33At = onchainNames.indexOf('JobBoard v33');
const meterAt = onchainNames.indexOf('Meter v20');
const v31At = onchainNames.indexOf('JobBoard v31');
assert(v32At >= 0 && v32At < v33At && v33At < meterAt && meterAt < v31At, onchainNames.join(' | '));
assert(cfg.abis.JB33.some((item) => item.name === 'OPEN_POST_LIMIT'), 'JB33 ABI is missing the v33 view');
assert(!cfg.abis.JB.some((item) => item.name === 'OPEN_POST_LIMIT'), 'v32 ABI picked up a v33 view');
assert(cfg.abis.JB33.some((item) => item.type === 'function' && item.name === 'nextJobId'), 'JB33 nextJobId missing');
assert(cfg.abis.JB33.some((item) => item.type === 'function' && item.name === 'getJob'), 'JB33 getJob missing');
assert(cfg.abis.ESC33.some((item) => item.type === 'function' && item.name === 'totalEscrowed'), 'ESC33 totalEscrowed missing');
assert(cfg.abis.ESC33.some((item) => item.type === 'function' && item.name === 'totalClaimable'), 'ESC33 totalClaimable missing');
assert(cfg.abis.ESC33.some((item) => item.type === 'function' && item.name === 'getDeal'), 'ESC33 getDeal missing');
assert(LOG_LOOKBACK === 3000n, 'lookback changed');
assert(listed(cfg.addresses.TileRegistry)?.status === 'current', 'RegistryNext is not marked current');
assert(listed('0xbded2d8bf0e5a8ecb276e463c4004fbd5f78c3f9')?.status === 'older', 'older TileRegistry is missing');
assert(cfg.addresses.TileRegistry.toLowerCase() === '0x38a27bda10fa4ffd61406642f558818f91333d12', 'live reads are not on RegistryNext');
assert(!JSON.stringify(directory).includes('\u2014'), 'directory contains an em dash');
const page = readFileSync(new URL('../live/index.html', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../live/dashboard.js', import.meta.url), 'utf8');
const wording = 'The OnChain counts and custody table follow JobBoard v32 (older, still live) and the current Meter, Split and Stream. The claim table and wallet panel read the current contracts. Recent activity also includes older contracts, marked (older). Older contracts remain on Base Sepolia.';
assert(page.includes(wording), 'contract list wording missing');
assert(page.includes('DemoTreasury, SanctionsOracle, and DemoGeometry are shared with the older Breakaway sets. CharterRegistry and GovernanceRouter belong to the current redeploy.'), 'shared contract sentence missing');
assert(!page.includes('Current rows are what the panels above read'), 'old contract list wording remains');
assert(source.includes("item.name + ' (older)'"), 'recent activity omits the older marker');
assert(bundle.includes('(older)'), 'bundled dashboard omits the older marker');
assert(bundle.includes('No live auctions in the current read'), 'bundled dashboard omits the live auction panel');
assert(bundle.includes('RefundWithdrawn is counted separately'), 'bundled dashboard omits the refund definition');
assert(bundle.includes('Not shown as zero'), 'bundled dashboard omits the unavailable wording');
assert(bundle.includes('JobBoard v33'), 'bundled dashboard omits JobBoard v33');
assert(bundle.includes('JB33'), 'bundled dashboard omits JB33');
assert(bundle.includes('56661016'), 'bundled dashboard omits the v33 deploy block');
assert(!/blockscout/i.test(source + page), 'dashboard calls Blockscout');
assert(!source.includes('innerHTML'), 'dashboard source uses innerHTML');
assert(!/eth_send/i.test(source), 'dashboard source mentions a send method');
assert(page.includes('id="live-auctions"'), 'live auctions panel missing');
assert(page.includes('id="activity-stats"'), 'activity stats missing');
assert(page.includes('not a full history'), 'covered-window wording missing');
assert(page.includes('OnChain jobs in covered window counts JobPosted'), 'jobs note still implies a full day');
assert(page.includes('not a full calendar-day total'), 'jobs note omits the calendar-day limit');
assert(page.includes('at most 3000 blocks, about 10 minutes on Base Sepolia'), 'jobs note omits the window length');
assert(page.includes('JobBoard v33 is the current build for new jobs. JobBoard v32 is an older build that is still live on Base Sepolia while its open jobs finish, and the primary metrics below still follow it. JobBoard v31 stays in the older rows.'), 'intro copy drifted');
assert(page.includes('JobBoard v33 is Current. JobBoard v32 and v31 are Older and still live.'), 'deployed contracts note drifted');
assert(page.includes('JobPosted on JobBoard v32 (older, still live)'), 'activity note still calls v32 current');
assert(!page.includes('the current JobBoard v32'), 'activity note still says the current JobBoard v32');
assert(!page.includes('both are live'), 'page still says both boards are live');
assert(source.includes('These readings follow JobBoard v32'), 'v32 metrics sentence changed');
assert(source.includes("(older, still live)"), 'jobs copy dropped the older still live phrase');
assert(page.includes('JobBoard v33 JobPosted events are not added to this count'), 'jobs note counts v33 into the v32 card');
assert(page.includes('id="metrics-v33"'), 'v33 metrics strip missing');
assert(page.includes('56661016'), 'page omits the v33 deploy block');
assert(page.includes('Covered blocks do not start at that deploy block'), 'page claims history since the v33 deploy block');
assert(page.includes('RefundWithdrawn is counted separately'), 'refund wording missing from the page');
assert(cfg.addresses.DemoAuction.toLowerCase() === '0xf2dec91b7c2290a837554c688c9d621dd23d18aa', 'DemoAuctionNext address drifted');

const SNAPSHOT_SIGS = {
  JobPosted: 'JobPosted(uint256,address,uint256,uint16,uint64,uint64,uint64,address,string,uint32,uint64,uint32,uint256)',
  AuctionCreated: 'AuctionCreated(uint16,uint256,uint256,bool)',
  BidPlaced: 'BidPlaced(uint16,address,uint256,uint256)',
  BidRefunded: 'BidRefunded(uint16,address,uint256)',
  RefundEscrowed: 'RefundEscrowed(uint16,address,uint256)',
  RefundWithdrawn: 'RefundWithdrawn(address,uint256)',
};
function eventSignature(abi, name) {
  const item = abi.find((entry) => entry.type === 'event' && entry.name === name);
  return {item, text: name + '(' + item.inputs.map((input) => input.type).join(',') + ')'};
}
for (const [name, sig] of Object.entries(SNAPSHOT_SIGS)) {
  const abi = name === 'JobPosted' ? cfg.abis.JB : cfg.abis.DemoAuction;
  const built = eventSignature(abi, name);
  const topic = encodeEventTopics({abi, eventName: name})[0];
  assert(built.text === sig, name + ' signature is ' + built.text);
  assert(topic.toLowerCase() === keccak256(toBytes(sig)).toLowerCase(), name + ' topic does not match the snapshot signature');
}
assert(eventSignature(cfg.abis.DemoAuction, 'BidPlaced').item.inputs.filter((input) => input.indexed).map((input) => input.name).join(',') === 'tileId,bidder', 'BidPlaced indexed fields drifted');
assert(eventSignature(cfg.abis.DemoAuction, 'AuctionCreated').item.inputs.filter((input) => input.indexed).map((input) => input.name).join(',') === 'tileId', 'AuctionCreated indexed fields drifted');
assert(eventSignature(cfg.abis.JB, 'JobPosted').item.inputs.filter((input) => input.indexed).map((input) => input.name).join(',') === 'jobId,buyer', 'JobPosted indexed fields drifted');
assert(eventSignature(cfg.abis.JB33, 'JobPosted').text === SNAPSHOT_SIGS.JobPosted, 'v33 JobPosted signature drifted');
assert(eventSignature(cfg.abis.JB33, 'JobPosted').item.inputs.filter((input) => input.indexed).map((input) => input.name).join(',') === 'jobId,buyer', 'v33 JobPosted indexed fields drifted');

const view = installDom();
useConfig(cfg);
setRequestGap(0);
setRetryDelay(async () => {});

const head = 5000000n;
const lookback = head - LOG_LOOKBACK;
const chain = {n: head};
const rpc = installRpc(chain);
setIdCap(100);
resetLogCache();

const progress = [];
let finished = 0;
for (let attempt = 1; attempt <= 8; attempt += 1) {
  rpc.begin();
  await refresh();
  const usage = budgetUsage();
  const coverage = logCoverage();
  progress.push({
    attempt,
    spent: usage.spent,
    rpc: rpc.rpcCount,
    from: coverage.from?.toString(),
    to: coverage.to?.toString(),
    status: view.text('#status'),
    error: view.text('#error'),
    scope: view.text('#eventscope'),
  });
  assert(usage.spent <= REQUEST_BUDGET, 'refresh ' + attempt + ' spent ' + usage.spent);
  assert(usage.spent === rpc.rpcCount, 'refresh ' + attempt + ' budget ' + usage.spent + ' vs rpc ' + rpc.rpcCount);
  const sectionSpent = Object.values(usage.sections).reduce((sum, item) => sum + item.spent, 0);
  assert(sectionSpent === usage.spent, 'per-section spends do not add up to ' + usage.spent);
  assert(coverage.to === head, 'coverage moved off the head');
  assert(coverage.from != null && coverage.from <= coverage.to, 'coverage is not a range');
  if (attempt === 1) {
    assert(coverage.from > lookback, 'cold backfill finished in one starved pass');
    assert(coverage.to - coverage.from + 1n >= 400n, 'cold backfill committed too little: ' + coverage.from);
    assert(view.text('#status') === 'Some readings are incomplete', view.text('#status'));
    assert(view.text('#updated') === '', 'timestamp advanced before the backfill finished');
    assert(view.text('#eventscope').includes('Covered blocks ' + coverage.from + ' to ' + coverage.to), view.text('#eventscope'));
    assert(view.text('#eventscope').includes('Backfill target is ' + lookback + ' to ' + head), view.text('#eventscope'));
    assert(view.text('#error').includes('Event backfill covers blocks'), view.text('#error'));
    assert(view.text('#runnernote') === 'Runner snapshot not published here. Chain panels read the public RPC separately. No runner statistics are invented.', view.text('#runnernote'));
    assert(rpc.calls.includes('eth_getLogs'), 'no log reads on the cold refresh');
  } else {
    const previous = BigInt(progress[attempt - 2].from);
    assert(coverage.from < previous || coverage.from === lookback, 'backfill did not advance');
  }
  if (coverage.from === lookback && view.text('#status') === 'Live snapshot complete') {
    finished = attempt;
    assert(!view.text('#eventscope').includes('Backfill target'), view.text('#eventscope'));
    assert(view.text('#updated').includes('block ' + head), view.text('#updated'));
    break;
  }
}
console.log(JSON.stringify(progress, null, 2));
assert(finished >= 2, 'backfill did not complete across refreshes');
assert(rpc.calls.filter((method) => method === 'eth_call').length > 20, 'maximum record reads were not exercised');

const bridged = {from: 1000n, to: 4000n, items: [log(4000n, 'cached')]};
const bridgePlan = planEventReads(bridged, 4201n);
assert(!bridgePlan.reset, 'a 201 block gap should bridge');
assert(bridgePlan.pages[0][0] <= 4001n, 'newest page starts past the cached tip: ' + bridgePlan.pages[0][0]);
const bridgedPage = commitLogPage(bridged, bridgePlan.pages[0][0], bridgePlan.pages[0][1], []);
assert(bridgedPage.ok, 'bridging page was rejected');
const farPlan = planEventReads(bridged, 4000n + 3500n);
assert(farPlan.reset, 'a gap past the lookback should start a new coverage');

const jumped = head + 201n;
chain.n = jumped;
rpc.begin();
await refresh();
let moved = logCoverage();
console.log('JUMP201', moved.from?.toString(), moved.to?.toString(), budgetUsage().spent, view.text('#status'));
assert(moved.to === jumped, '201 block head jump left coverage at ' + moved.to);
assert(moved.from === jumped - LOG_LOOKBACK, 'lookback was not pruned: ' + moved.from);
assert(moved.min == null || moved.min >= moved.from, 'cached event is older than coverage');
assert(moved.max == null || moved.max <= moved.to, 'cached event is newer than coverage');

const far = jumped + 3500n;
chain.n = far;
rpc.begin();
await refresh();
moved = logCoverage();
console.log('JUMP3500', moved.from?.toString(), moved.to?.toString(), budgetUsage().spent, view.text('#status'));
assert(moved.to === far, '3500 block head jump left coverage at ' + moved.to);
assert(moved.from > far - LOG_LOOKBACK, 'far jump kept a full old window');
assert(moved.min == null || moved.min >= far - LOG_LOOKBACK, 'far jump kept events outside the lookback');
assert(moved.max == null || moved.max <= far, 'far jump displayed a block past the head');
const farFrom = moved.from;
rpc.begin();
await refresh();
moved = logCoverage();
assert(moved.to === far, 'second far refresh left the new head');
assert(moved.from < farFrom, 'second far refresh did not continue the backfill');
chain.n = head;
resetLogCache();

setIdCap(200);
resetLogCache();
rpc.begin();
await refresh();
const overload = {spent: budgetUsage().spent, coverage: logCoverage(), error: view.text('#error'), status: view.text('#status')};
console.log('OVERLOAD', overload.spent, overload.coverage.from?.toString(), overload.coverage.to?.toString(), overload.status, overload.error);
assert(overload.spent <= REQUEST_BUDGET, 'overload spent ' + overload.spent);
assert(overload.coverage.to === head, 'overload coverage left the head');
assert(overload.coverage.to - overload.coverage.from + 1n >= 400n, 'overload backfill was starved');
assert(overload.status === 'Some readings are incomplete', overload.status);
assert(overload.error.includes('request budget'), overload.error);
const before = overload.coverage.from;
rpc.begin();
await refresh();
const nextCoverage = logCoverage();
assert(budgetUsage().spent <= REQUEST_BUDGET, 'second overload spent ' + budgetUsage().spent);
assert(nextCoverage.from < before, 'overload backfill did not resume');
assert(nextCoverage.to === head, 'resumed coverage left the head');
setIdCap(100);

const baseHead = 5000n;
const rolled = baseHead - 5n;
const base = {
  from: rolled - LOG_LOOKBACK,
  to: baseHead,
  items: [
    log(baseHead, 'tip'),
    log(baseHead - 1n, 'near'),
    log(rolled, 'at-head'),
    log(baseHead - 10n, 'overlap-old'),
    log(4000n, 'old'),
  ],
};

const removed = applyHead(base, rolled, [log(4970n, 'survivor')]);
assert(removed.pages.every(([start, end]) => end <= rolled && start >= rolled - REORG_DEPTH), 'rollback read past the new head');
assert(removed.state.to === rolled, 'claimed head was not rolled back');
assert(removed.state.items.every((item) => item.blockNumber <= removed.state.to && item.blockNumber >= removed.state.from), 'cache escaped coverage');
assert(!removed.state.items.some((item) => ['tip', 'near', 'at-head', 'overlap-old'].includes(item.transactionHash)), 'removed logs stayed in cache');
assert(removed.state.items.some((item) => item.transactionHash === 'old'), 'older log was dropped');
assert(visibleLogs(removed.state).every((item) => item.blockNumber <= rolled), 'display passed the new head');

const replaced = applyHead(base, rolled, [log(rolled, 'replacement')]);
assert(replaced.state.items.some((item) => item.transactionHash === 'replacement'), 'replacement log missing');
assert(!replaced.state.items.some((item) => item.transactionHash === 'at-head' || item.transactionHash === 'overlap-old'), 'old overlap logs remained');
assert(replaced.state.items.some((item) => item.transactionHash === 'old'), 'older log dropped during replacement');
assert(replaced.state.to === rolled, 'replacement claimed the old head');

const emptied = applyHead(base, rolled, []);
assert(emptied.state.to === rolled && emptied.state.from === base.from, 'empty replacement changed the claimed range');
assert(!emptied.state.items.some((item) => item.blockNumber >= rolled - REORG_DEPTH), 'empty overlap kept old logs');
assert(emptied.state.items.some((item) => item.transactionHash === 'old'), 'empty replacement dropped older logs');
assert(visibleLogs(emptied.state).every((item) => item.blockNumber <= rolled), 'empty rollback displayed a future block');

rpc.flags.failBalances = true;
resetLogCache();
setIdCap(100);
rpc.begin();
await refresh();
const failedWallets = budgetUsage();
const walletText = collectText(document.querySelector('#wallets'));
console.log('WALLETS', failedWallets.sections.wallets, failedWallets.sections.events, rpc.counts, walletText);
assert(failedWallets.sections.wallets.spent <= SECTION_RESERVES.wallets, 'wallets spent ' + failedWallets.sections.wallets.spent);
assert(failedWallets.sections.wallets.spent >= rpc.counts.eth_getBalance, 'balance reads were not charged to wallets');
assert(failedWallets.sections.events.spent === rpc.counts.eth_getLogs, 'event reserve paid for ' + rpc.counts.eth_getLogs + ' logs but recorded ' + failedWallets.sections.events.spent);
assert(rpc.counts.eth_getBalance === 5, 'persistent balance failures were retried or skipped: ' + rpc.counts.eth_getBalance);
assert(walletText.includes('Unavailable'), 'persistent wallet failure was shown as a value');
assert(view.text('#status') === 'Some readings are incomplete', view.text('#status'));
rpc.flags.failBalances = false;

const deepTip = 5000n;
const deepHead = 4900n;
assert(deepHead + REORG_DEPTH < deepTip, 'fixture is not a deep rollback');
const deepPlan = planEventReads({from: 2000n, to: deepTip, items: []}, deepHead, deepTip);
assert(deepPlan.reset, 'planner kept coverage across a deep rollback');
const shallowHead = deepTip - 5n;
const shallowPlan = planEventReads({from: 2000n, to: deepTip, items: []}, shallowHead, deepTip);
assert(!shallowPlan.reset, 'a 5 block rollback was treated as deep');
assert(shallowPlan.pages.some(([start, end]) => start === shallowHead - REORG_DEPTH && end === shallowHead), 'a 5 block rollback shortened the overlap: ' + shallowPlan.pages.map((page) => page.join('-')).join(','));
const exactHead = deepTip - REORG_DEPTH;
const exactPlan = planEventReads({from: 2000n, to: deepTip, items: []}, exactHead, deepTip);
assert(!exactPlan.reset, 'a rollback of exactly 32 blocks was treated as deep');
assert(exactPlan.pages.some(([start, end]) => start === exactHead - REORG_DEPTH && end === exactHead), 'a rollback of exactly 32 blocks shortened the overlap: ' + exactPlan.pages.map((page) => page.join('-')).join(','));
seedLogCache({
  from: 2000n,
  to: deepTip,
  items: [log(4800n, 'orphan-4800'), log(deepTip, 'old-tip')],
});
chain.n = deepHead;
let deepPartial = false;
let deepDone = false;
for (let step = 1; step <= 8; step += 1) {
  rpc.begin();
  await refresh();
  const cov = logCoverage();
  console.log('DEEP', step, cov.from?.toString(), cov.to?.toString(), view.text('#status'), cov.hashes);
  assert(!cov.hashes.includes('orphan-4800'), 'orphan below the overlap survived refresh ' + step);
  assert(!cov.hashes.includes('old-tip'), 'old tip survived refresh ' + step);
  assert(cov.to === deepHead, 'deep rollback coverage ended at ' + cov.to);
  assert(cov.min == null || cov.min >= cov.from, 'deep rollback cache escaped coverage');
  if (view.text('#status') !== 'Live snapshot complete') deepPartial = true;
  else assert(cov.from === deepHead - LOG_LOOKBACK, 'complete before the replacement window finished');
  if (step === 1) assert(cov.from > 2000n, 'old coverage prefix was kept');
  if (cov.from === deepHead - LOG_LOOKBACK && view.text('#status') === 'Live snapshot complete') {
    deepDone = true;
    break;
  }
}
assert(deepPartial, 'deep rollback was marked complete immediately');
assert(deepDone, 'replacement coverage did not finish');

async function proveShallowRollback({label, tip, nextHead, orphanBlock, orphanHash}) {
  const from = nextHead > LOG_LOOKBACK ? nextHead - LOG_LOOKBACK : 0n;
  const keeper = 'keeper-' + label;
  assert(nextHead < tip && nextHead + REORG_DEPTH >= tip, label + ' fixture is not a shallow rollback');
  assert(orphanBlock >= nextHead - REORG_DEPTH && orphanBlock <= nextHead, label + ' orphan is outside the replacement overlap');
  assert(orphanBlock < tip - REORG_DEPTH, label + ' orphan would already be inside the shortened overlap');
  seedLogCache({
    from,
    to: tip,
    items: [log(4000n, keeper), log(orphanBlock, orphanHash), log(tip, 'old-tip-' + label)],
  });
  chain.n = nextHead;
  let done = false;
  for (let step = 1; step <= 4; step += 1) {
    rpc.begin();
    await refresh();
    const cov = logCoverage();
    const ranges = rpc.ranges.map(([start, end]) => start + ':' + end).join(' ');
    console.log('SHALLOW', label, step, cov.from?.toString(), cov.to?.toString(), view.text('#status'), cov.hashes, ranges);
    assert(cov.hashes.includes(keeper), label + ' dropped a log below the overlap on refresh ' + step);
    assert(!cov.hashes.includes('old-tip-' + label), label + ' kept a log above the new head on refresh ' + step);
    assert(cov.to === nextHead, label + ' coverage ended at ' + cov.to);
    assert(cov.from === from, label + ' reset coverage that was still inside the overlap');
    const overlapRead = rpc.ranges.some(([start, end]) => start <= nextHead - REORG_DEPTH && end >= nextHead);
    if (view.text('#status') === 'Live snapshot complete') {
      assert(overlapRead, label + ' reported complete without rereading the full overlap');
      assert(!cov.hashes.includes(orphanHash), label + ' reported complete while the overlap orphan remained');
      done = true;
      break;
    }
    assert(view.text('#status') === 'Some readings are incomplete', label + ' status was ' + view.text('#status'));
  }
  assert(done, label + ' replacement overlap did not finish');
  assert(!logCoverage().hashes.includes(orphanHash), label + ' overlap orphan survived');
}

await proveShallowRollback({
  label: '5',
  tip: 5000n,
  nextHead: 4995n,
  orphanBlock: 4965n,
  orphanHash: 'orphan-4965',
});
await proveShallowRollback({
  label: '32',
  tip: 5000n,
  nextHead: 5000n - REORG_DEPTH,
  orphanBlock: 4967n,
  orphanHash: 'orphan-4967',
});
chain.n = head;
resetLogCache();

rpc.flags.calm = true;
armTestBudget();
const walletBudget = openSection('wallets');
walletBudget.left = 1;
const firstBalance = enqueueRpc('eth_getBalance', [cfg.addresses.JB, '0x1']);
await firstBalance;
const queued = [
  enqueueRpc('eth_getBalance', [cfg.addresses.JB, '0x1']),
  enqueueRpc('eth_getBalance', [cfg.addresses.JB, '0x1']),
  enqueueRpc('eth_getBalance', [cfg.addresses.JB, '0x1']),
];
openSection('events');
queued.push(enqueueRpc('eth_getLogs', [{
  address: [cfg.addresses.JB],
  fromBlock: '0x20',
  toBlock: '0x20',
}]));
const raced = await Promise.allSettled(queued);
const raceUsage = budgetUsage();
console.log('RACE', raceUsage.sections, raced.map((item) => item.status));
assert(raceUsage.sections.wallets.spent === 1, 'outstanding balances spent ' + raceUsage.sections.wallets.spent);
assert(raceUsage.sections.events.spent === 1, 'event section spent ' + raceUsage.sections.events.spent);
assert(raceUsage.spent === 2, 'race spent ' + raceUsage.spent);
assert(raced.slice(0, 3).every((item) => item.status === 'rejected'), 'queued balances ran on the event reserve');

rpc.flags.calm = true;
rpc.begin();
armTestBudget();
const splitBudget = openSection('events');
splitBudget.left = 2;
const splitFrom = 8000000n;
let splitError = null;
try {
  await readLogWindow([cfg.addresses.JB], splitFrom, splitFrom + 199n, splitBudget);
} catch (error) {
  splitError = error;
}
const leftTo = splitFrom + 99n;
const rightFrom = splitFrom + 100n;
console.log('SPLIT', splitBudget.spent, splitError && splitError.message, rpc.ranges.map(([from, to]) => from + ':' + to).join(' '));
assert(splitError && /request budget/i.test(splitError.message), 'split did not stop on the budget');
assert(splitBudget.spent === 2, 'split spent ' + splitBudget.spent);
assert(splitBudget.left === 0, 'split left budget behind');
assert(rpc.ranges.some(([from, to]) => from === splitFrom && to === leftTo), 'left child did not succeed');
assert(!rpc.ranges.some(([from]) => from === rightFrom), 'right child was sent after the budget was gone');
rpc.flags.calm = false;

rpc.flags.calm = true;
rpc.flags.activityAddress = '0x6c53EaD9a3174957032F65D897b70333428AdfF4';
chain.n = head;
resetLogCache();
rpc.begin();
await refresh();
const recent = collectText(document.querySelector('#recent'));
console.log('OLDER ACTIVITY', recent);
assert(recent.includes('JobBoard v31 (older)'), recent);
assert(contractLabel(cfg.addresses.JB) === 'JobBoard v32 (older)', contractLabel(cfg.addresses.JB));
assert(contractLabel(cfg.addresses.ESC) === 'Job escrow, v32 set (older)', contractLabel(cfg.addresses.ESC));
assert(!recent.includes('JobBoard v32 (older)'), recent);
rpc.flags.activityAddress = '';
rpc.flags.calm = false;

const OLDER_AUCTION = '0x6b70115e110f45ccd0f076b5147c5a10ad576c17';
const OLDER_BOARD = '0x6c53EaD9a3174957032F65D897b70333428AdfF4';
const BIDDER_A = '0xAc4a57256fcaBDB241a18f565d89189Dbd692405';
const BIDDER_B = '0x83487DEAD07AB45b2E1F335A636F1a3F09381040';
const FIXTURE_HEAD = 199n;

function encodeLog(abi, eventName, args) {
  const item = abi.find((entry) => entry.type === 'event' && entry.name === eventName);
  const topics = encodeEventTopics({abi, eventName, args});
  const fields = item.inputs.filter((input) => !input.indexed);
  const data = fields.length ? encodeAbiParameters(fields, fields.map((input) => args[input.name])) : '0x';
  return {topics, data};
}

function rpcLog({address, blockNumber, logIndex, transactionHash, abi, eventName, args}) {
  const encoded = encodeLog(abi, eventName, args);
  return {
    address,
    blockNumber: '0x' + BigInt(blockNumber).toString(16),
    logIndex: '0x' + BigInt(logIndex).toString(16),
    transactionHash,
    data: encoded.data,
    topics: encoded.topics,
  };
}

function auctionLog(address, blockNumber, logIndex, transactionHash, eventName, args) {
  return rpcLog({address, blockNumber, logIndex, transactionHash, abi: cfg.abis.DemoAuction, eventName, args});
}

function jobArgs(jobId) {
  return {
    jobId,
    buyer: '0x4bDE94B713e5B25ca1A244CE6196b4F61f6f8FE3',
    budget: 1500000000n,
    feeCeilingBps: 0,
    commitEnd: 0n,
    revealStart: 0n,
    revealEnd: 0n,
    arbiter: ZERO,
    label: 'fixture',
    arbiterWindow: 0,
    longestHold: 0n,
    lateReviewExtension: 0,
    arbiterThreshold: 0n,
  };
}

function clearFixtures() {
  rpc.flags.extraLogs = [];
  rpc.flags.auctionByTile = null;
  rpc.flags.failAuctions = null;
  rpc.flags.failFunctions = null;
  rpc.flags.timestampFor = null;
  rpc.flags.activityAddress = '';
  rpc.flags.calm = true;
  rpc.flags.failBalances = false;
}

async function refreshChecked() {
  rpc.begin();
  await refresh();
  const usage = budgetUsage();
  assert(usage.spent <= REQUEST_BUDGET, 'spent ' + usage.spent);
  assert(usage.spent === rpc.rpcCount, 'budget ' + usage.spent + ' vs ' + rpc.rpcCount);
  const sectionSpent = Object.values(usage.sections).reduce((sum, item) => sum + item.spent, 0);
  assert(sectionSpent === usage.spent, 'section spends drifted');
  return usage;
}

async function fullWindowRefresh() {
  chain.n = FIXTURE_HEAD;
  resetLogCache();
  setIdCap(100);
  const usage = await refreshChecked();
  const cov = logCoverage();
  assert(cov.from === 0n && cov.to === FIXTURE_HEAD, 'coverage ' + cov.from + ' to ' + cov.to);
  return usage;
}

clearFixtures();
rpc.flags.failAuctions = new Set([12]);
chain.n = head;
resetLogCache();
setIdCap(100);
await refreshChecked();
assert(rpc.counts.eth_getBlockByNumber === 1, 'partial refresh fetched job block times: ' + rpc.counts.eth_getBlockByNumber);
for (const title of ['OnChain jobs in covered window', 'Breakaway auctions', 'Breakaway bids', 'Breakaway refunds']) {
  const card = cardAt(title);
  assert(card.value === 'Unavailable', title + ' was ' + card.value);
  assert(card.value !== '0', title + ' coerced a partial window to zero');
  assert(card.sub.includes('incomplete'), title + ' ' + card.sub);
  assert(card.sub.includes('Not shown as zero'), title + ' ' + card.sub);
  assert(card.sub.includes('Not a full history'), title + ' ' + card.sub);
}
const failedLive = tableRows('#live-auctions');
assert(failedLive.length === 1, JSON.stringify(failedLive));
assert(failedLive[0][0] === '12' && failedLive[0][1] === 'Unavailable', JSON.stringify(failedLive));
assert(failedLive[0][2] === 'Unavailable' && failedLive[0][2] !== '0 test ETH', failedLive[0][2]);
assert(failedLive[0][3] === 'Unavailable' && failedLive[0][5] === 'Unavailable', JSON.stringify(failedLive));
assert(!collectText(document.querySelector('#live-auctions')).includes('0 test ETH'), 'failed auction rendered a zero bid');
assert(view.text('#status') === 'Some readings are incomplete', view.text('#status'));

clearFixtures();
let usage = await fullWindowRefresh();
assert(view.text('#status') === 'Live snapshot complete', view.text('#error'));
let liveRows = tableRows('#live-auctions');
assert(liveRows.length === 1 && liveRows[0][0] === 'None' && liveRows[0][1] === 'No live auctions in the current read', JSON.stringify(liveRows));
assert(cardAt('Breakaway auctions').value === '0', 'complete empty window hid a real zero');
assert(cardAt('Breakaway auctions').sub.includes('Covered blocks 0 to 199'), cardAt('Breakaway auctions').sub);
assert(cardAt('OnChain jobs in covered window').value === '0');
assertJobsWindow(cardAt('OnChain jobs in covered window'));
console.log('EMPTY WINDOW', usage.spent, usage.sections);

clearFixtures();
rpc.flags.auctionByTile = {
  12: {endTime: 5000n, highestBidder: BIDDER_B, seed: 51000000000000000n, reserve: 50000000000000000n},
  36: {endTime: 50n, highestBidder: BIDDER_A, seed: 10000000000000000n, reserve: 1n},
  60: {endTime: 40n, highestBidder: ZERO, seed: 0n, reserve: 1n},
};
await fullWindowRefresh();
assert(view.text('#status') === 'Live snapshot complete', view.text('#error'));
liveRows = tableRows('#live-auctions');
assert(liveRows.map((row) => row[0]).join(',') === '12,60,36', JSON.stringify(liveRows));
assert(liveRows[0][1] === 'Live' && liveRows[0][5] === 'Unavailable', JSON.stringify(liveRows[0]));
assert(liveRows[0][2].includes('test ETH') && liveRows[0][2] !== 'Unavailable', liveRows[0][2]);
assert(liveRows[1][1] === 'Ended, no bids' && liveRows[1][3] === 'No bids' && liveRows[1][5] === 'Not counted', JSON.stringify(liveRows[1]));
assert(liveRows[2][1] === 'Ended, settle pending' && liveRows[2][5] === 'Not counted', JSON.stringify(liveRows[2]));
assert(!liveRows.some((row) => row[0] === '35'), 'unopened tile 35 was listed');
assert(!collectText(document.querySelector('#live-auctions')).includes('(older)'), 'live panel marked a current auction older');

clearFixtures();
const headDay = BigInt(Math.floor(Date.parse('2026-11-09T18:00:00Z') / 1000));
rpc.flags.timestampFor = () => headDay;
rpc.flags.auctionByTile = {
  12: {endTime: 1794849050n, highestBidder: BIDDER_B, seed: 51000000000000000n, reserve: 50000000000000000n},
  35: {endTime: 1794849057n, highestBidder: BIDDER_A, seed: 50000000000000000n, reserve: 50000000000000000n},
};
rpc.flags.extraLogs = [
  auctionLog(cfg.addresses.DemoAuction, 150, 0, '0x764bdbb0c337e03f7d1dbf6f2887305ae46c53e31a9aebae5683af4e56f51ef0', 'AuctionCreated', {tileId: 12, endTime: 1794849050n, reserve: 50000000000000000n, reEntry: false}),
  auctionLog(cfg.addresses.DemoAuction, 151, 0, '0xa0809541f73f530cf02e6617b53dd91eeffdcd88282dbd63abc8db518e88a1ae', 'AuctionCreated', {tileId: 35, endTime: 1794849057n, reserve: 50000000000000000n, reEntry: false}),
  auctionLog(cfg.addresses.DemoAuction, 152, 0, '0x9ab31faa0da43627fbaa15c05d0f3f3fb2094dada020631f5467953805cb6c1a', 'BidPlaced', {tileId: 12, bidder: BIDDER_A, seed: 50000000000000000n, newEndTime: 1794849050n}),
  auctionLog(cfg.addresses.DemoAuction, 153, 0, '0x3b30682f061ab3cdb5badd5d72319c364efddffc64817733e0265f052e56fcc9', 'BidPlaced', {tileId: 12, bidder: BIDDER_B, seed: 51000000000000000n, newEndTime: 1794849050n}),
  auctionLog(cfg.addresses.DemoAuction, 154, 0, '0xc1abb39bfafab6b5df07422d47e88fd20facf53d7a061fb0479853dd1012cb36', 'BidPlaced', {tileId: 35, bidder: BIDDER_A, seed: 50000000000000000n, newEndTime: 1794849057n}),
  auctionLog(OLDER_AUCTION, 155, 0, keccak256(toBytes('older-create')), 'AuctionCreated', {tileId: 12, endTime: 1794849050n, reserve: 1n, reEntry: false}),
  auctionLog(OLDER_AUCTION, 156, 0, keccak256(toBytes('older-bid')), 'BidPlaced', {tileId: 12, bidder: BIDDER_A, seed: 1n, newEndTime: 1799999999n}),
  rpcLog({address: OLDER_BOARD, blockNumber: 157, logIndex: 0, transactionHash: keccak256(toBytes('v31-job')), abi: cfg.abis.JB, eventName: 'JobPosted', args: jobArgs(7n)}),
];
usage = await fullWindowRefresh();
assert(view.text('#status') === 'Live snapshot complete', view.text('#error'));
liveRows = tableRows('#live-auctions');
assert(liveRows.map((row) => row[0]).join(',') === '12,35', JSON.stringify(liveRows));
assert(liveRows.every((row) => row[1] === 'Live'), JSON.stringify(liveRows));
assert(liveRows[0][5] === '0' && liveRows[1][5] === '0', 'snapshot bids were counted as extensions ' + liveRows.map((row) => row[5]).join(','));
assert(liveRows[0][2].includes('0.051'), liveRows[0][2]);
assert(liveRows[1][2].includes('0.05') && !liveRows[1][2].includes('0.051'), liveRows[1][2]);
assert(liveRows[0][3].toLowerCase().includes('0x83487d'), liveRows[0][3]);
assert(cardAt('Breakaway auctions').value === '2', cardAt('Breakaway auctions').value);
assert(cardAt('Breakaway bids').value === '3', cardAt('Breakaway bids').value);
assert(cardAt('Breakaway refunds').value === '0', cardAt('Breakaway refunds').value);
assert(cardAt('Breakaway refunds').sub.includes('Withdrawn: 0'), cardAt('Breakaway refunds').sub);
assert(cardAt('Breakaway refunds').sub.includes('RefundWithdrawn is counted separately'), cardAt('Breakaway refunds').sub);
assert(cardAt('OnChain jobs in covered window').value === '0', cardAt('OnChain jobs in covered window').value);
assert(cardAt('OnChain jobs in covered window').sub.includes('2026-11-09'), cardAt('OnChain jobs in covered window').sub);
assert(cardAt('OnChain jobs in covered window').sub.includes('JobBoard v32'), cardAt('OnChain jobs in covered window').sub);
assert(cardAt('OnChain jobs in covered window').sub.includes('JobBoard v32 (older, still live)'), cardAt('OnChain jobs in covered window').sub);
assert(cardAt('OnChain jobs in covered window').sub.includes('JobBoard v31 is not included'), cardAt('OnChain jobs in covered window').sub);
assert(!cardAt('OnChain jobs in covered window').sub.includes('the current '), cardAt('OnChain jobs in covered window').sub);
assertJobsWindow(cardAt('OnChain jobs in covered window'));
assert(cardAt('Breakaway auctions').sub.includes('DemoCharterAuctionNext'), cardAt('Breakaway auctions').sub);
assert(cardAt('Breakaway auctions').sub.includes('Covered blocks 0 to 199'), cardAt('Breakaway auctions').sub);
assert(rpc.counts.eth_getBlockByNumber === 1, 'no JobPosted still fetched timestamps ' + rpc.counts.eth_getBlockByNumber);
console.log('SNAPSHOT FIXTURE', usage.spent, JSON.stringify(usage.sections));

clearFixtures();
rpc.flags.auctionByTile = {
  12: {endTime: 9000n, highestBidder: BIDDER_A, seed: 2000000000000000000n, reserve: 1n},
  35: {endTime: 8000n, highestBidder: BIDDER_A, seed: 1000000000000000000n, reserve: 1n},
};
rpc.flags.extraLogs = [
  auctionLog(cfg.addresses.DemoAuction, 140, 0, keccak256(toBytes('c12')), 'AuctionCreated', {tileId: 12, endTime: 1000n, reserve: 1n, reEntry: false}),
  auctionLog(cfg.addresses.DemoAuction, 141, 0, keccak256(toBytes('b12')), 'BidPlaced', {tileId: 12, bidder: BIDDER_A, seed: 2000000000000000000n, newEndTime: 2000n}),
  auctionLog(cfg.addresses.DemoAuction, 142, 0, keccak256(toBytes('b12-short')), 'BidPlaced', {tileId: 12, bidder: BIDDER_A, seed: 3000000000000000000n, newEndTime: 1500n}),
  auctionLog(cfg.addresses.DemoAuction, 143, 0, keccak256(toBytes('b35-only')), 'BidPlaced', {tileId: 35, bidder: BIDDER_A, seed: 1n, newEndTime: 99999n}),
];
await fullWindowRefresh();
assert(view.text('#status') === 'Live snapshot complete', view.text('#error'));
liveRows = tableRows('#live-auctions');
const byTile = Object.fromEntries(liveRows.map((row) => [row[0], row]));
assert(byTile['12'][1] === 'Live' && byTile['12'][5] === '1', JSON.stringify(byTile['12']));
assert(byTile['35'][1] === 'Live' && byTile['35'][5] === 'Unavailable', JSON.stringify(byTile['35']));
assert(byTile['35'][5] !== '0', 'missing AuctionCreated was counted as zero extensions');

clearFixtures();
const sharedHash = keccak256(toBytes('same-tx'));
rpc.flags.extraLogs = [
  auctionLog(cfg.addresses.DemoAuction, 160, 0, sharedHash, 'AuctionCreated', {tileId: 12, endTime: 1000n, reserve: 1n, reEntry: false}),
  auctionLog(cfg.addresses.DemoAuction, 160, 1, sharedHash, 'AuctionCreated', {tileId: 35, endTime: 1100n, reserve: 1n, reEntry: true}),
];
await fullWindowRefresh();
assert(cardAt('Breakaway auctions').value === '2', 'same-transaction creates were collapsed');

clearFixtures();
rpc.flags.extraLogs = [
  auctionLog(cfg.addresses.DemoAuction, 150, 0, keccak256(toBytes('br')), 'BidRefunded', {tileId: 12, bidder: BIDDER_A, amount: 50000000000000000n}),
  auctionLog(cfg.addresses.DemoAuction, 151, 0, keccak256(toBytes('re')), 'RefundEscrowed', {tileId: 12, bidder: BIDDER_A, amount: 51000000000000000n}),
  auctionLog(cfg.addresses.DemoAuction, 152, 0, keccak256(toBytes('rw')), 'RefundWithdrawn', {to: BIDDER_A, amount: 1n}),
  auctionLog(OLDER_AUCTION, 153, 0, keccak256(toBytes('obr')), 'BidRefunded', {tileId: 12, bidder: BIDDER_A, amount: 9n}),
  auctionLog(OLDER_AUCTION, 154, 0, keccak256(toBytes('ore')), 'RefundEscrowed', {tileId: 12, bidder: BIDDER_A, amount: 9n}),
  auctionLog(OLDER_AUCTION, 155, 0, keccak256(toBytes('orw')), 'RefundWithdrawn', {to: BIDDER_A, amount: 9n}),
];
await fullWindowRefresh();
assert(view.text('#status') === 'Live snapshot complete', view.text('#error'));
assert(cardAt('Breakaway refunds').value === '2', cardAt('Breakaway refunds').value + ' ' + cardAt('Breakaway refunds').sub);
assert(cardAt('Breakaway refunds').sub.includes('Withdrawn: 1'), cardAt('Breakaway refunds').sub);
assert(cardAt('Breakaway auctions').value === '0' && cardAt('Breakaway bids').value === '0', 'refund logs inflated auction or bid counts');

clearFixtures();
rpc.flags.extraLogs = [
  auctionLog(cfg.addresses.DemoAuction, 150, 0, keccak256(toBytes('only-w')), 'RefundWithdrawn', {to: BIDDER_A, amount: 4n}),
];
await fullWindowRefresh();
assert(cardAt('Breakaway refunds').value === '0', cardAt('Breakaway refunds').value);
assert(cardAt('Breakaway refunds').sub.includes('Withdrawn: 1'), cardAt('Breakaway refunds').sub);
assert(cardAt('Breakaway refunds').value !== '1', 'a withdrawal was counted as a refund');

clearFixtures();
const today = BigInt(Math.floor(Date.parse('2026-11-09T18:00:00Z') / 1000));
const yesterday = BigInt(Math.floor(Date.parse('2026-11-08T18:00:00Z') / 1000));
rpc.flags.timestampFor = (block) => block === 150n ? yesterday : today;
rpc.flags.extraLogs = [
  rpcLog({address: cfg.addresses.JB, blockNumber: 150, logIndex: 0, transactionHash: keccak256(toBytes('job-y')), abi: cfg.abis.JB, eventName: 'JobPosted', args: jobArgs(1n)}),
  rpcLog({address: cfg.addresses.JB, blockNumber: 151, logIndex: 0, transactionHash: keccak256(toBytes('job-t')), abi: cfg.abis.JB, eventName: 'JobPosted', args: jobArgs(2n)}),
  rpcLog({address: OLDER_BOARD, blockNumber: 151, logIndex: 1, transactionHash: keccak256(toBytes('job-v31')), abi: cfg.abis.JB, eventName: 'JobPosted', args: jobArgs(7n)}),
];
usage = await fullWindowRefresh();
assert(view.text('#status') === 'Live snapshot complete', view.text('#error'));
assert(cardAt('OnChain jobs in covered window').value === '1', cardAt('OnChain jobs in covered window').value + ' ' + cardAt('OnChain jobs in covered window').sub);
assert(cardAt('OnChain jobs in covered window').sub.includes('2026-11-09'), cardAt('OnChain jobs in covered window').sub);
assertJobsWindow(cardAt('OnChain jobs in covered window'));
assert(rpc.counts.eth_getBlockByNumber === 3, 'timestamp reads ' + rpc.counts.eth_getBlockByNumber);
assert(usage.sections.events.spent <= SECTION_RESERVES.events, 'events reserve overrun ' + usage.sections.events.spent);
console.log('JOB DAY', usage.spent, usage.sections.events);

clearFixtures();
rpc.flags.timestampFor = () => today;
rpc.flags.extraLogs = [];
for (let index = 0; index < 9; index += 1) {
  rpc.flags.extraLogs.push(rpcLog({
    address: cfg.addresses.JB,
    blockNumber: 100 + index,
    logIndex: 0,
    transactionHash: keccak256(toBytes('cap-' + index)),
    abi: cfg.abis.JB,
    eventName: 'JobPosted',
    args: jobArgs(BigInt(index + 1)),
  }));
}
await fullWindowRefresh();
assert(cardAt('OnChain jobs in covered window').value === 'Unavailable', cardAt('OnChain jobs in covered window').value);
assert(cardAt('OnChain jobs in covered window').value !== '0', 'stamp cap coerced the day count to zero');
assert(cardAt('OnChain jobs in covered window').sub.includes('more than 8'), cardAt('OnChain jobs in covered window').sub);
assert(cardAt('Breakaway auctions').value === '0', 'stamp cap hid a complete auction count');
assert(rpc.counts.eth_getBlockByNumber === 1, 'cap still fetched job blocks ' + rpc.counts.eth_getBlockByNumber);
assert(view.text('#status') === 'Some readings are incomplete', view.text('#status') + ' ' + view.text('#error'));

clearFixtures();
const badJob = encodeLog(cfg.abis.JB, 'JobPosted', jobArgs(1n));
rpc.flags.extraLogs = [{
  address: cfg.addresses.JB,
  blockNumber: '0x96',
  logIndex: '0x0',
  transactionHash: keccak256(toBytes('bad-job')),
  data: '0x',
  topics: badJob.topics,
}];
await fullWindowRefresh();
assert(cardAt('OnChain jobs in covered window').value === 'Unavailable', cardAt('OnChain jobs in covered window').value);
assert(cardAt('OnChain jobs in covered window').sub.includes('could not be decoded'), cardAt('OnChain jobs in covered window').sub);
assert(cardAt('OnChain jobs in covered window').value !== '0', 'a failed JobPosted decode was counted as zero');
assert(view.text('#status') === 'Some readings are incomplete', view.text('#status'));

clearFixtures();
rpc.flags.timestampFor = () => today;
rpc.flags.extraLogs = [
  rpcLog({address: cfg.addresses.JB33, blockNumber: 151, logIndex: 0, transactionHash: keccak256(toBytes('job-v33-only')), abi: cfg.abis.JB33, eventName: 'JobPosted', args: jobArgs(9n)}),
];
usage = await fullWindowRefresh();
assert(cardAt('OnChain jobs in covered window').value === '0', cardAt('OnChain jobs in covered window').value);
assert(cardAt('OnChain jobs in covered window').sub.includes('JobBoard v32 (older, still live)'), cardAt('OnChain jobs in covered window').sub);
assert(!cardAt('OnChain jobs in covered window').sub.includes('the current '), cardAt('OnChain jobs in covered window').sub);
assert(cardAt('OnChain jobs in covered window').sub.includes('JobBoard v33 posts are not added to this count'), cardAt('OnChain jobs in covered window').sub);
assert(rpc.counts.eth_getBlockByNumber === 1, 'v33 JobPosted fetched day timestamps ' + rpc.counts.eth_getBlockByNumber);
assert(usage.spent <= REQUEST_BUDGET, 'v33 refresh spent ' + usage.spent);
assert(usage.sections.onchain.spent <= SECTION_RESERVES.onchain, 'onchain reserve overrun ' + usage.sections.onchain.spent);
assert(contractLabel(cfg.addresses.JB33) === 'JobBoard v33', contractLabel(cfg.addresses.JB33));
assert(!contractLabel(cfg.addresses.JB33).includes('(older)'), contractLabel(cfg.addresses.JB33));
assert(contractLabel(cfg.addresses.JB) === 'JobBoard v32 (older)', contractLabel(cfg.addresses.JB));
let v33Rows = tableRows('#recent').filter((row) => row[2] === 'JobBoard v33');
assert(v33Rows.length === 1 && v33Rows[0][3] === 'JobPosted', JSON.stringify(tableRows('#recent')));
assert(!collectText(document.querySelector('#recent')).includes('JobBoard v33 (older)'), 'v33 was marked older');
const v33Next = cardAt('Next job id', '#metrics-v33');
assert(v33Next.value === String(currentIdCap() + 1n), v33Next.value);
assert(v33Next.value !== 'Unavailable' && v33Next.value !== '0', v33Next.value);
assert(v33Next.sub.includes('JobBoard v33') && v33Next.sub.includes('56661016'), v33Next.sub);
assert(cardAt('Held in escrow', '#metrics-v33').value === '0 MUSDC', cardAt('Held in escrow', '#metrics-v33').value);
console.log('V33 QUIET', usage.spent, usage.sections.onchain);

clearFixtures();
rpc.flags.timestampFor = () => today;
rpc.flags.extraLogs = [
  rpcLog({address: cfg.addresses.JB, blockNumber: 150, logIndex: 0, transactionHash: keccak256(toBytes('job-v32-keep')), abi: cfg.abis.JB, eventName: 'JobPosted', args: jobArgs(4n)}),
  rpcLog({address: cfg.addresses.JB33, blockNumber: 151, logIndex: 0, transactionHash: keccak256(toBytes('job-v33-side')), abi: cfg.abis.JB33, eventName: 'JobPosted', args: jobArgs(8n)}),
];
await fullWindowRefresh();
assert(cardAt('OnChain jobs in covered window').value === '1', 'older directory status dropped the v32 JobPosted count ' + cardAt('OnChain jobs in covered window').value + ' ' + cardAt('OnChain jobs in covered window').sub);
assert(rpc.counts.eth_getBlockByNumber === 2, 'v33 log added a timestamp read ' + rpc.counts.eth_getBlockByNumber);
v33Rows = tableRows('#recent').filter((row) => row[2] === 'JobBoard v33');
assert(v33Rows.length === 1 && v33Rows[0][3] === 'JobPosted', JSON.stringify(v33Rows));
const v32Rows = tableRows('#recent').filter((row) => row[2] === 'JobBoard v32 (older)');
assert(v32Rows.some((row) => row[3] === 'JobPosted'), 'v32 activity was not decoded from the JB key ' + JSON.stringify(v32Rows));
const custody = tableRows('#custody');
assert(custody.some((row) => row[0] === 'Job escrow, v32 set'), 'metrics left the ESC key ' + JSON.stringify(custody.map((row) => row[0])));
assert(view.text('#scope').includes('These readings follow JobBoard v32'), view.text('#scope'));

clearFixtures();
rpc.flags.failFunctions = new Set([cfg.addresses.JB33.toLowerCase() + ':nextJobId']);
await fullWindowRefresh();
const failedV33 = cardAt('Next job id', '#metrics-v33');
assert(failedV33.value === 'Unavailable', failedV33.value);
assert(failedV33.value !== '0', 'failed v33 nextJobId rendered as zero');
assert(cardAt('Held in escrow', '#metrics-v33').value === '0 MUSDC', 'a failed nextJobId blanked a successful escrow read');
assert(view.text('#status') === 'Some readings are incomplete', view.text('#status') + ' ' + view.text('#error'));
assert(view.text('#error').includes('JobBoard v33'), view.text('#error'));

clearFixtures();
chain.n = head;
resetLogCache();

console.log('live dashboard checks passed');

function tableRows(selector) {
  const root = document.querySelector(selector);
  const grid = root.children[0];
  if (!grid) return [];
  return grid.children.slice(1).map((row) => row.children.map((cell) => collectText(cell)));
}

function assertJobsWindow(card) {
  assert(card.sub.includes('not a full calendar-day total'), card.sub);
  assert(card.sub.includes('3000'), card.sub);
}

function cardAt(title, rootSel = '#activity-stats') {
  const root = document.querySelector(rootSel);
  const article = root.children.find((node) => node.children[0]?.textContent === title);
  assert(article, 'missing card ' + title);
  return {value: article.children[1].textContent, sub: article.children[2].textContent};
}

function collectText(node, out = []) {
  if (!node) return out.join(' ');
  if (node.children?.length) {
    for (const child of node.children) collectText(child, out);
  } else if (node.textContent) out.push(node.textContent);
  return out.join(' ');
}
