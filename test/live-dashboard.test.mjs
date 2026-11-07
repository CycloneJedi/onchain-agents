import {readFileSync} from 'node:fs';
import {decodeFunctionData, encodeFunctionResult} from 'viem';

globalThis.LIVE_DASHBOARD_TEST = true;
const dash = await import('../live/dashboard.mjs');

const {
  REQUEST_BUDGET,
  SECTION_RESERVES,
  LOG_LOOKBACK,
  REORG_DEPTH,
  refresh,
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
    if (decoded.functionName === 'nextJobId' || decoded.functionName === 'nextId') result = currentIdCap() + 1n;
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
    if (body.method === 'eth_getBlockByNumber') return rpcResult({timestamp: '0x64'});
    if (body.method === 'eth_getBalance') {
      if (flags.failBalances) return rpcError({code: -32000, message: 'balance unavailable'});
      if (!flags.calm && once('balance')) return rpcError({code: -32007, message: 'too many requests'}, 429);
      return rpcResult('0x1');
    }
    if (body.method === 'eth_getLogs') {
      const from = BigInt(body.params[0].fromBlock);
      const to = BigInt(body.params[0].toBlock);
      const key = from + ':' + to;
      if (!flags.calm && once('log429:' + key)) return rpcError({code: -32007, message: 'too many requests'}, 429);
      if (!flags.calm && to - from + 1n > 100n) return rpcError({code: -32005, message: 'query returned more than 10000 results'});
      return rpcResult([{
        address: cfg.addresses.JB,
        blockNumber: body.params[0].toBlock,
        logIndex: '0x0',
        transactionHash: '0x' + to.toString(16).padStart(64, '0'),
        data: '0x',
        topics: ['0x' + '11'.repeat(32)],
      }]);
    }
    if (body.method === 'eth_call') {
      ethCalls += 1;
      if (ethCalls === 2) return rpcError({code: -32000, message: 'response too large'});
      const decoded = decodeFunctionData({abi: MULTICALL_ABI, data: body.params[0].data});
      const rows = decoded.args[0].map((call) => ({
        success: true,
        payload: encodeInner(call.target, call.callData),
      }));
      return rpcResult(encodeFunctionResult({abi: MULTICALL_ABI, functionName: 'aggregate3', result: rows}));
    }
    throw new Error('Unexpected RPC method ' + body.method);
  };

  return {
    begin() {
      rpcCount = 0;
      ethCalls = 0;
      counts = {};
    },
    get rpcCount() { return rpcCount; },
    get calls() { return calls; },
    get counts() { return counts; },
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

rpc.flags.calm = false;
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
console.log('SPLIT', splitBudget.spent, splitError && splitError.message);
assert(splitError && /request budget/i.test(splitError.message), 'split did not stop on the budget');
assert(splitBudget.spent === 2, 'split spent ' + splitBudget.spent);
assert(splitBudget.left === 0, 'split left budget behind');
rpc.flags.calm = false;

console.log('live dashboard checks passed');

function collectText(node, out = []) {
  if (!node) return out.join(' ');
  if (node.children?.length) {
    for (const child of node.children) collectText(child, out);
  } else if (node.textContent) out.push(node.textContent);
  return out.join(' ');
}
