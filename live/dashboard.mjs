// Read-only Base Sepolia (chain 84532) dashboard.
// Public eth_call, eth_getLogs, eth_getBalance, and block reads only.
// No wallet, no signing, no private keys.
import {decodeEventLog, decodeFunctionResult, encodeFunctionData, formatUnits} from 'viem';

const RPC = 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const EXPLORER = 'https://sepolia.basescan.org';
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';
const GAP_MS = 120;
const ADDR = /^0x[a-fA-F0-9]{40}$/;

const $ = (s) => document.querySelector(s);
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  const bits = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    bits.push(current.shortMessage, current.message, current.details, current.code);
    current = current.cause;
  }
  return bits.filter((bit) => bit != null).join(' ');
}

function rateLimited(error) {
  const text = errorText(error).toLowerCase();
  const status = error?.status ?? error?.cause?.status ?? error?.cause?.cause?.status;
  return status === 429 || status === 503 || text.includes('too many') || text.includes('rate limit') || text.includes('25/second') || text.includes('-32007');
}

function explain(error) {
  const text = errorText(error);
  if (rateLimited(error)) return 'the public RPC is rate limiting requests';
  if (/timeout|timed out|failed to fetch/i.test(text)) return 'the public RPC timed out or could not be reached';
  if (/wrong chain/i.test(text)) return 'Wrong chain. Expected Base Sepolia 84532.';
  const short = error?.shortMessage || error?.message || 'the public RPC request failed';
  if (short.length > 180 || /https?:|0x[a-fA-F0-9]{8}/.test(short)) return 'the public RPC request failed';
  return short;
}

const multicallAbi = [{
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
      {name: 'returnData', type: 'bytes'},
    ],
  }],
}];

function toHex(value) {
  return '0x' + BigInt(value).toString(16);
}

async function rpc(method, params) {
  let response;
  try {
    response = await fetch(RPC, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    const failed = new Error('the public RPC request failed');
    failed.cause = error;
    failed.details = error?.message || 'network';
    throw failed;
  }
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok || !body || body.error) {
    const failed = new Error(body?.error?.message || ('HTTP ' + response.status));
    failed.status = response.status;
    failed.code = body?.error?.code;
    failed.details = body?.error?.message || text.slice(0, 180);
    throw failed;
  }
  return body.result;
}

let gate = Promise.resolve();
let lastCall = 0;

function spaced(fn) {
  const run = gate.then(async () => {
    const gap = GAP_MS - (Date.now() - lastCall);
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();
    return rpcRetry(fn);
  });
  gate = run.then(() => {}, () => {});
  return run;
}

function retryable(error) {
  const status = error?.status ?? error?.cause?.status;
  return rateLimited(error) || status === 502 || status === 504 || /timeout|timed out|failed to fetch|networkerror/i.test(errorText(error));
}

async function rpcRetry(fn) {
  let wait = 1000;
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!retryable(error) || attempt === 4) throw error;
      const status = $('#status');
      if (status) status.textContent = rateLimited(error) ? 'Public RPC rate limit. Retrying…' : 'Public RPC issue. Retrying…';
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
  throw last;
}

function decodeMulticall(data) {
  const decoded = decodeFunctionResult({abi: multicallAbi, functionName: 'aggregate3', data});
  if (Array.isArray(decoded)) return decoded;
  return decoded.returnData;
}

async function multicall(contracts, blockNumber) {
  if (!contracts.length) return [];
  try {
    return await spaced(async () => {
      const calls = contracts.map((item) => ({
        target: item.address,
        allowFailure: true,
        callData: encodeFunctionData({abi: item.abi, functionName: item.functionName, args: item.args || []}),
      }));
      const data = encodeFunctionData({abi: multicallAbi, functionName: 'aggregate3', args: [calls]});
      const raw = await rpc('eth_call', [{to: MULTICALL, data}, toHex(blockNumber)]);
      const rows = decodeMulticall(raw);
      return contracts.map((item, index) => {
        const row = rows[index];
        const success = row?.success ?? row?.[0];
        const returnData = row?.returnData ?? row?.[1];
        if (!success || !returnData || returnData === '0x') {
          return {status: 'failure', error: new Error('Contract call failed')};
        }
        try {
          return {
            status: 'success',
            result: decodeFunctionResult({abi: item.abi, functionName: item.functionName, data: returnData}),
          };
        } catch (error) {
          return {status: 'failure', error};
        }
      });
    });
  } catch (error) {
    if (contracts.length === 1 || retryable(error)) throw error;
    const mid = Math.floor(contracts.length / 2);
    const left = await multicall(contracts.slice(0, mid), blockNumber);
    const right = await multicall(contracts.slice(mid), blockNumber);
    return left.concat(right);
  }
}

function must(result, label) {
  if (!result || result.status !== 'success') {
    const reason = result?.error ? explain(result.error) : 'no result';
    const error = new Error(label + ' failed: ' + reason);
    if (result?.error && rateLimited(result.error)) error.rateLimited = true;
    throw error;
  }
  return result.result;
}

function call(contract, functionName, args = []) {
  return {address: A[contract], abi: AB[contract], functionName, args};
}

function idRange(next) {
  const end = BigInt(next);
  const from = end > 200n ? end - 200n : 1n;
  const ids = [];
  for (let id = from; id < end; id += 1n) ids.push(id);
  return ids;
}

function num(value, decimals = 6) {
  return Number(formatUnits(BigInt(value || 0), decimals)).toLocaleString(undefined, {maximumFractionDigits: 6});
}

function small(address) {
  return address.slice(0, 8) + '…' + address.slice(-6);
}

function isZero(address) {
  return String(address).toLowerCase() === ZERO;
}

function link(type, value, label) {
  const anchor = el('a', label || value);
  anchor.href = EXPLORER + '/' + type + '/' + value;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function card(parent, title, value, sub = '') {
  const article = el('article');
  article.append(el('h3', title), el('strong', value), el('p', sub));
  parent.append(article);
}

function table(parent, headers, rows) {
  const root = el('table');
  const head = el('tr');
  for (const header of headers) head.append(el('th', header));
  root.append(head);
  for (const row of rows) {
    const line = el('tr');
    for (const value of row) {
      const cell = el('td');
      cell.append(value instanceof Node ? value : document.createTextNode(String(value)));
      line.append(cell);
    }
    root.append(line);
  }
  parent.replaceChildren(root);
}

function stateSummary(items) {
  const counts = {};
  for (const item of items) {
    if (item?.state == null) continue;
    const key = 'State ' + Number(item.state);
    counts[key] = (counts[key] || 0) + 1;
  }
  const text = Object.entries(counts).map(([key, count]) => key + ': ' + count).join(' · ');
  return text || 'No records';
}

function mt(seconds) {
  return new Date(Number(seconds) * 1000).toLocaleString('en-CA', {timeZone: 'America/Edmonton', hour12: false}) + ' MT';
}

function labelOf(name) {
  return cfg.labels?.[name] || name;
}

function rangeTooWide(error) {
  const text = errorText(error).toLowerCase();
  return text.includes('block range') || text.includes('more than') || text.includes('query returned') || text.includes('too large') || text.includes('exceed') || text.includes('10000') || text.includes('10,000');
}

async function getLogsRange(addresses, fromBlock, toBlock) {
  try {
    return await spaced(async () => {
      const raw = await rpc('eth_getLogs', [{
        address: addresses,
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
      }]);
      if (!Array.isArray(raw)) throw new Error('Log page was not a list');
      return raw.map((log) => ({
        address: log.address,
        blockNumber: BigInt(log.blockNumber),
        logIndex: BigInt(log.logIndex),
        transactionHash: log.transactionHash,
        data: log.data,
        topics: log.topics,
      }));
    });
  } catch (error) {
    if (!rangeTooWide(error) || fromBlock >= toBlock) throw error;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const older = await getLogsRange(addresses, fromBlock, mid);
    const newer = await getLogsRange(addresses, mid + 1n, toBlock);
    return older.concat(newer);
  }
}

let cfg;
let A;
let AB;
let busy = false;

function requirePublicAddresses(map, kind) {
  for (const [name, value] of Object.entries(map || {})) {
    if (typeof value !== 'string' || !ADDR.test(value)) {
      throw new Error(kind + ' ' + name + ' is not a public address.');
    }
  }
}

async function loadConfig() {
  const response = await fetch('./config.json', {cache: 'no-store'});
  if (!response.ok) throw new Error('Dashboard config did not load (' + response.status + ').');
  const next = await response.json();
  requirePublicAddresses(next.addresses, 'Contract');
  requirePublicAddresses(next.wallets, 'Wallet');
  if (!next.abis || !Array.isArray(next.tiles)) throw new Error('Dashboard config is incomplete.');
  cfg = next;
  A = cfg.addresses;
  AB = cfg.abis;
}

function renderAddresses() {
  const rows = Object.entries(A).map(([name, address]) => [labelOf(name), link('address', address, address)]);
  table($('#addresses'), ['Contract', 'Base Sepolia explorer'], rows);
}

async function loadOnchain(blockNumber) {
  const services = ['ESC', 'SP', 'MT', 'ST'];
  const head = await multicall([
    call('JB', 'nextJobId'),
    call('SP', 'nextId'),
    call('MT', 'nextId'),
    call('ST', 'nextId'),
    ...services.flatMap((name) => [call(name, 'totalEscrowed'), call(name, 'totalClaimable')]),
  ], blockNumber);
  const nextJob = must(head[0], 'Job board id');
  const nextByService = {SP: must(head[1], 'Split id'), MT: must(head[2], 'Meter id'), ST: must(head[3], 'Stream id')};
  const serviceRows = services.map((name, index) => {
    const held = head[4 + index * 2];
    const ready = head[5 + index * 2];
    return [
      labelOf(name),
      held.status === 'success' ? num(held.result) + ' MUSDC' : 'Unavailable',
      ready.status === 'success' ? num(ready.result) + ' MUSDC' : 'Unavailable',
    ];
  });
  const jobIds = idRange(nextJob);
  const recordCalls = [
    ...jobIds.flatMap((id) => [call('JB', 'getJob', [id]), call('ESC', 'getDeal', [id])]),
    ...idRange(nextByService.SP).map((id) => call('SP', 'getDeal', [id])),
    ...idRange(nextByService.MT).map((id) => call('MT', 'meterOf', [id])),
    ...idRange(nextByService.ST).map((id) => call('ST', 'streamOf', [id])),
  ];
  const records = await multicall(recordCalls, blockNumber);
  let cursor = 0;
  const jobs = [];
  const deals = [];
  for (const id of jobIds) {
    const job = records[cursor];
    cursor += 1;
    const deal = records[cursor];
    cursor += 1;
    if (job?.status === 'success') jobs.push({id, ...job.result});
    if (deal?.status === 'success' && deal.result.fundedAt > 0n) deals.push({id, ...deal.result});
  }
  const cards = [
    ['Jobs', String(jobs.length), stateSummary(jobs)],
    ['Funded jobs', String(deals.length), stateSummary(deals)],
    ['Job principal', num(deals.reduce((sum, deal) => sum + deal.price, 0n)) + ' MUSDC', 'Sum of funded job prices in the sampled IDs'],
  ];
  for (const name of ['SP', 'MT', 'ST']) {
    const items = [];
    for (const _id of idRange(nextByService[name])) {
      const row = records[cursor];
      cursor += 1;
      if (row?.status !== 'success') continue;
      items.push(name === 'SP' ? row.result[2] : row.result);
    }
    cards.push([labelOf(name) + ' records', String(items.length), stateSummary(items)]);
  }
  const metrics = $('#metrics');
  metrics.replaceChildren();
  for (const [title, value, sub] of cards) card(metrics, title, value, sub);
  $('#scope').textContent = "State numbers are the contracts' enum values. Job and service counts cover up to the latest 200 IDs per contract, not an unlimited history.";
  table($('#custody'), ['Service', 'Held in active work', 'Ready to withdraw'], serviceRows);
}

async function loadBreakaway(blockNumber) {
  const calls = cfg.tiles.flatMap((tile) => [
    call('TileRegistry', 'getTileState', [tile]),
    call('DemoAuction', 'getAuction', [tile]),
  ]);
  const results = await multicall(calls, blockNumber);
  const states = {};
  let seed = 0n;
  const rows = [];
  cfg.tiles.forEach((tile, index) => {
    const state = results[index * 2];
    const auction = results[index * 2 + 1];
    const stateText = state?.status === 'success' ? Number(state.result) : 'Unavailable';
    if (state?.status === 'success') states[stateText] = (states[stateText] || 0) + 1;
    const data = auction?.status === 'success' ? auction.result : null;
    if (data) seed += data[2];
    const close = !data ? 'Unavailable' : data[0] === 0n ? 'Not opened' : mt(data[0]);
    const leader = !data ? 'Unavailable' : isZero(data[1]) ? 'No bids' : link('address', data[1], small(data[1]));
    rows.push([
      tile,
      stateText,
      close,
      leader,
      data ? num(data[2], 18) + ' test ETH' : 'Unavailable',
      data ? num(data[3], 18) + ' test ETH' : 'Unavailable',
    ]);
  });
  const summary = Object.entries(states).map(([key, count]) => 'state ' + key + ': ' + count).join(' · ');
  $('#bkstats').textContent = cfg.tiles.length + ' practice claims · ' + (summary || 'no state') + ' · active seed ' + num(seed, 18) + ' test ETH';
  table($('#claims'), ['Claim', 'State', 'Auction close (MT)', 'Leading wallet', 'Bid seed', 'Reserve'], rows);
}

async function loadWallets(blockNumber) {
  const entries = Object.entries(cfg.wallets);
  const balances = await Promise.all(entries.map(async ([, address]) => {
    try {
      return await spaced(async () => BigInt(await rpc('eth_getBalance', [address, toHex(blockNumber)])));
    } catch {
      return null;
    }
  }));
  const practice = await multicall(entries.map(([, address]) => call('MUSDC', 'balanceOf', [address])), blockNumber);
  const rows = entries.map(([name, address], index) => [
    name,
    link('address', address, small(address)),
    balances[index] == null ? 'Unavailable' : num(balances[index], 18) + ' test ETH',
    practice[index]?.status === 'success' ? num(practice[index].result) + ' MUSDC' : 'Unavailable',
  ]);
  table($('#wallets'), ['Agent wallet', 'Address', 'Gas balance', 'Practice balance'], rows);
}

async function loadEvents(blockNumber) {
  const addresses = Object.keys(AB).filter((name) => name !== 'MUSDC' && A[name]).map((name) => A[name]);
  const start = blockNumber > 3000n ? blockNumber - 3000n : 0n;
  const logs = [];
  for (let from = start; from <= blockNumber; from += 200n) {
    const to = from + 199n > blockNumber ? blockNumber : from + 199n;
    logs.push(...await getLogsRange(addresses, from, to));
  }
  logs.sort((left, right) => Number(right.blockNumber - left.blockNumber) || Number(right.logIndex - left.logIndex));
  const rows = [];
  const seen = new Set();
  for (const log of logs) {
    if (seen.has(log.transactionHash)) continue;
    seen.add(log.transactionHash);
    const name = Object.keys(A).find((key) => A[key].toLowerCase() === log.address.toLowerCase());
    let event = 'Contract event';
    if (name && AB[name]) {
      try {
        event = decodeEventLog({abi: AB[name], data: log.data, topics: log.topics, strict: false}).eventName || event;
      } catch {
        event = 'Contract event';
      }
    }
    rows.push([
      log.blockNumber,
      link('tx', log.transactionHash, small(log.transactionHash)),
      labelOf(name || 'Contract'),
      event,
    ]);
    if (rows.length >= 30) break;
  }
  if (!rows.length) rows.push(['None', 'No contract events in these blocks', '', '']);
  table($('#recent'), ['Block', 'Transaction', 'Contract', 'Action event'], rows);
  $('#eventscope').textContent = 'Contract events from blocks ' + start + ' to ' + blockNumber + '. This is not a complete transaction history. Receipt success and gas are in the runner panel when a snapshot is published.';
}

async function loadRunner() {
  const note = $('#runnernote');
  try {
    const response = await fetch('./stats.json?at=' + Date.now(), {cache: 'no-store'});
    if (!response.ok) throw new Error('unavailable');
    const snapshot = await response.json();
    if (!snapshot || typeof snapshot !== 'object' || snapshot.updated_mt == null || snapshot.transactions == null) {
      throw new Error('unavailable');
    }
    const panel = $('#runner');
    panel.replaceChildren();
    card(panel, 'Runner', String(snapshot.runner ?? 'Unknown'), 'Snapshot: ' + snapshot.updated_mt);
    card(panel, 'Confirmed transactions', String(snapshot.transactions), (snapshot.successful ?? 0) + ' succeeded · ' + (snapshot.failed ?? 0) + ' failed');
    card(panel, 'Pace', String(snapshot.paceSeconds ?? 'Unknown') + ' seconds', 'At most one transaction per tick');
    card(panel, 'Gas spent', num(snapshot.gasSpentWei, 18) + ' test ETH');
    panel.append(el('p', (snapshot.blockers || []).join(' ')));
    table($('#runrecent'), ['Action', 'Receipt', 'Gas units', 'Hash'], (snapshot.latest || []).slice(0, 12).map((item) => [
      item.action,
      item.success ? 'Success' : 'Failed',
      item.gasUsed,
      item.hash ? link('tx', item.hash, small(item.hash)) : 'None',
    ]));
    table($('#active'), ['Runner item', 'On-chain ID', 'Progress phase', 'Issue'], (snapshot.active || []).map((item) => [
      item.kind,
      item.id || 'Not yet created',
      item.phase,
      item.error?.message || 'None',
    ]));
    note.textContent = 'Runner figures come from a published snapshot file, not from the chain. They are only as current as the snapshot time shown. The chain panels above read the public Base Sepolia RPC; previously displayed values may be stale if a refresh fails.';
  } catch {
    note.textContent = 'Runner snapshot not published here. Chain panels remain live. No runner statistics are invented.';
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  $('#refresh').disabled = true;
  $('#error').textContent = '';
  $('#status').textContent = 'Reading public RPC…';
  const problems = [];
  try {
    const chainId = await spaced(async () => Number(BigInt(await rpc('eth_chainId', []))));
    if (chainId !== CHAIN_ID) throw new Error('Wrong chain. Expected Base Sepolia 84532.');
    const blockNumber = await spaced(async () => BigInt(await rpc('eth_blockNumber', [])));
    const block = await spaced(async () => {
      const raw = await rpc('eth_getBlockByNumber', [toHex(blockNumber), false]);
      if (!raw?.timestamp) throw new Error('Block timestamp unavailable');
      return {timestamp: BigInt(raw.timestamp)};
    });
    $('#network').textContent = 'Base Sepolia · chain 84532 · block ' + blockNumber;
    $('#updated').textContent = 'Chain snapshot ' + mt(block.timestamp);
    try {
      await loadOnchain(blockNumber);
    } catch (error) {
      problems.push('Project OnChain: ' + explain(error) + '.');
    }
    try {
      await loadBreakaway(blockNumber);
    } catch (error) {
      problems.push('Breakaway: ' + explain(error) + '.');
    }
    try {
      await loadWallets(blockNumber);
    } catch (error) {
      problems.push('Wallets: ' + explain(error) + '.');
    }
    try {
      await loadEvents(blockNumber);
    } catch (error) {
      problems.push('Recent activity: ' + explain(error) + '.');
      $('#eventscope').textContent = 'Recent events could not be read: ' + explain(error) + '. Other panels keep the last good readings.';
    }
    await loadRunner();
    if (problems.length) {
      $('#error').textContent = 'Refresh incomplete. ' + problems.join(' ') + ' Previously displayed values may be stale.';
      $('#status').textContent = 'Some readings are incomplete';
    } else {
      $('#status').textContent = 'Live snapshot complete';
    }
  } catch (error) {
    console.error('Dashboard RPC read failed', errorText(error));
    $('#error').textContent = 'Refresh incomplete: ' + explain(error) + '. Previously displayed values may be stale.';
    $('#status').textContent = 'RPC read issue';
  } finally {
    busy = false;
    $('#refresh').disabled = false;
  }
}

async function start() {
  try {
    await loadConfig();
  } catch (error) {
    $('#error').textContent = error.message || 'Dashboard config did not load.';
    $('#status').textContent = 'Config unavailable';
    $('#network').textContent = 'Base Sepolia config did not load.';
    return;
  }
  renderAddresses();
  $('#refresh').onclick = () => { refresh(); };
  await refresh();
  setInterval(() => { refresh(); }, 60000);
}

await start();
