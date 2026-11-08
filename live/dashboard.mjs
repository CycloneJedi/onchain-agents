// Read-only Base Sepolia (chain 84532) dashboard.
// Public eth_call, eth_getLogs, eth_getBalance, and block reads only.
// No wallet, no signing, no private keys.
// Rebuild live/dashboard.js with: npm ci && npm run build:live
// See live/BUILD.md.
import {decodeEventLog, decodeFunctionResult, encodeFunctionData, formatUnits} from 'viem';

const RPC = 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const EXPLORER = 'https://sepolia.basescan.org';
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';
const GAP_MS = 120;
const CALL_BATCH = 20;
// A clean read of the supported window fits in this cap. Record reads cannot spend the event share.
export const REQUEST_BUDGET = 64;
export const SECTION_RESERVES = {meta: 4, onchain: 30, breakaway: 5, wallets: 8, events: 17};
const LOG_CHUNK = 200n;
const LOG_LOOKBACK = 3000n;
const REORG_DEPTH = 32n;
export {LOG_LOOKBACK, REORG_DEPTH};
const SUPPORTED_ID_CAP = 100n;
const FILE_TIMEOUT_MS = 8000;
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

function budgetSpent(error) {
  return /request budget/i.test(errorText(error));
}

function explain(error) {
  const text = errorText(error);
  if (budgetSpent(error)) return 'the public RPC request budget for this refresh is used up';
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
      {name: 'payload', type: 'bytes'},
    ],
  }],
}];

function toHex(value) {
  return '0x' + BigInt(value).toString(16);
}

let active = null;
let sectionBudgets = {};
let sharedLeft = 0;
let spentTotal = 0;
let reserveOverrides = null;
let gapMs = GAP_MS;
let retryWait = sleep;
let idCap = SUPPORTED_ID_CAP;

export function setRequestGap(ms) {
  gapMs = ms;
}

export function setRetryDelay(fn) {
  retryWait = fn;
}

export function setIdCap(value) {
  idCap = BigInt(value);
}

export function currentIdCap() {
  return idCap;
}

export function budgetUsage() {
  const sections = {};
  for (const [name, budget] of Object.entries(sectionBudgets)) {
    sections[name] = {spent: budget.spent, left: budget.left, closed: budget.closed};
  }
  return {spent: spentTotal, reserveLeft: active ? active.left : 0, sharedLeft, sections};
}

export function setSectionReserves(overrides) {
  reserveOverrides = overrides;
}

function reserveFor(name) {
  if (reserveOverrides && Object.prototype.hasOwnProperty.call(reserveOverrides, name)) return reserveOverrides[name];
  return SECTION_RESERVES[name] || 0;
}

function armBudget() {
  active = null;
  sectionBudgets = {};
  sharedLeft = 0;
  spentTotal = 0;
}

function useSection(name) {
  if (active && !active.closed) {
    sharedLeft += active.left;
    active.left = 0;
    active.closed = true;
  }
  const budget = {name, left: reserveFor(name), spent: 0, closed: false};
  sectionBudgets[name] = budget;
  active = budget;
  return budget;
}

function takeRequest(budget) {
  const owner = budget || active;
  if (!owner || owner.closed || spentTotal >= REQUEST_BUDGET || (owner.left <= 0 && sharedLeft <= 0)) {
    throw new Error('Public RPC request budget for this refresh is used up.');
  }
  if (owner.left > 0) owner.left -= 1;
  else sharedLeft -= 1;
  owner.spent += 1;
  spentTotal += 1;
}

async function rpc(method, params, budget) {
  takeRequest(budget || active);
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
    const gap = gapMs - (Date.now() - lastCall);
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();
    return rpcRetry(fn);
  });
  gate = run.then(() => {}, () => {});
  return run;
}

function retryable(error) {
  if (budgetSpent(error)) return false;
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
      const status = typeof document === 'undefined' ? null : $('#status');
      if (status) status.textContent = rateLimited(error) ? 'Public RPC rate limit. Retrying…' : 'Public RPC issue. Retrying…';
      const jitter = Math.floor(Math.random() * Math.floor(wait * 0.25 + 1));
      await retryWait(wait + jitter);
      wait = Math.min(wait * 2, 8000);
    }
  }
  throw last;
}

function decodeMulticall(data) {
  const decoded = decodeFunctionResult({abi: multicallAbi, functionName: 'aggregate3', data});
  if (Array.isArray(decoded)) return decoded;
  return decoded.payload ?? decoded.returnData;
}

function rowValue(row) {
  const success = row?.success ?? row?.[0];
  const payload = row?.payload ?? row?.returnData ?? row?.[1];
  return {success, payload};
}

async function multicall(contracts, blockNumber, budget = active) {
  if (!contracts.length) return [];
  if (contracts.length > CALL_BATCH) {
    const out = [];
    for (let index = 0; index < contracts.length; index += CALL_BATCH) {
      out.push(...await multicall(contracts.slice(index, index + CALL_BATCH), blockNumber, budget));
    }
    return out;
  }
  try {
    return await spaced(async () => {
      const calls = contracts.map((item) => ({
        target: item.address,
        allowFailure: true,
        callData: encodeFunctionData({abi: item.abi, functionName: item.functionName, args: item.args || []}),
      }));
      const data = encodeFunctionData({abi: multicallAbi, functionName: 'aggregate3', args: [calls]});
      const raw = await rpc('eth_call', [{to: MULTICALL, data}, toHex(blockNumber)], budget);
      const rows = decodeMulticall(raw);
      return contracts.map((item, index) => {
        const {success, payload} = rowValue(rows?.[index]);
        if (!success || !payload || payload === '0x') {
          return {status: 'failure', error: new Error('Contract call failed')};
        }
        try {
          return {
            status: 'success',
            result: decodeFunctionResult({abi: item.abi, functionName: item.functionName, data: payload}),
          };
        } catch (error) {
          return {status: 'failure', error};
        }
      });
    });
  } catch (error) {
    if (contracts.length === 1 || retryable(error) || budgetSpent(error)) throw error;
    const mid = Math.floor(contracts.length / 2);
    const left = await multicall(contracts.slice(0, mid), blockNumber, budget);
    const right = await multicall(contracts.slice(mid), blockNumber, budget);
    return left.concat(right);
  }
}

function must(result, label) {
  if (!result || result.status !== 'success') {
    const reason = result?.error ? explain(result.error) : 'no result';
    const error = new Error(label + ' failed: ' + reason);
    throw error;
  }
  return result.result;
}

function call(contract, functionName, args = []) {
  return {address: A[contract], abi: AB[contract], functionName, args};
}

function idRange(next) {
  const end = BigInt(next);
  const from = end > idCap ? end - idCap : 1n;
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

function countLabel(read, unavailable) {
  if (!unavailable) return String(read);
  return read + ' read';
}

function withGaps(summary, unavailable, noun) {
  if (!unavailable) return summary;
  return summary + ' · Unavailable ' + noun + ': ' + unavailable + '.';
}

function mt(seconds) {
  return new Date(Number(seconds) * 1000).toLocaleString('en-CA', {timeZone: 'America/Edmonton', hour12: false}) + ' MT';
}

function labelOf(name) {
  return cfg.labels?.[name] || name;
}

function markRead(id, blockNumber) {
  const node = document.getElementById(id);
  if (node) node.textContent = 'Last read block ' + blockNumber + '.';
}

function rangeTooWide(error) {
  const text = errorText(error).toLowerCase();
  return text.includes('block range') || text.includes('more than') || text.includes('query returned') || text.includes('too large') || text.includes('exceed') || text.includes('10000') || text.includes('10,000');
}

async function getLogsRange(addresses, fromBlock, toBlock, budget = active) {
  try {
    return await spaced(async () => {
      const raw = await rpc('eth_getLogs', [{
        address: addresses,
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
      }], budget);
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
    if (!rangeTooWide(error) || budgetSpent(error) || fromBlock >= toBlock) throw error;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const older = await getLogsRange(addresses, fromBlock, mid, budget);
    const newer = await getLogsRange(addresses, mid + 1n, toBlock, budget);
    return older.concat(newer);
  }
}

export function logWindows(from, to) {
  const windows = [];
  let end = to;
  while (end >= from) {
    const start = end - (LOG_CHUNK - 1n) > from ? end - (LOG_CHUNK - 1n) : from;
    windows.push([start, end]);
    if (start === from) break;
    end = start - 1n;
  }
  return windows;
}

export function createLogCache() {
  return {from: null, to: null, items: []};
}

export function discardAboveHead(state, head) {
  if (state.from == null || state.to == null) return createLogCache();
  if (head < state.from) return createLogCache();
  const to = state.to > head ? head : state.to;
  return {
    from: state.from,
    to,
    items: state.items.filter((item) => item.blockNumber >= state.from && item.blockNumber <= to),
  };
}

export function commitLogPage(state, start, end, logs) {
  const page = [];
  for (const item of logs) {
    if (item.blockNumber < start || item.blockNumber > end) continue;
    page.push(item);
  }
  let from = state.from;
  let to = state.to;
  if (from == null || to == null) {
    from = start;
    to = end;
  } else if (start <= to + 1n && end >= from - 1n) {
    if (start < from) from = start;
    if (end > to) to = end;
  } else {
    return {ok: false, state};
  }
  const items = state.items
    .filter((item) => item.blockNumber < start || item.blockNumber > end)
    .concat(page)
    .filter((item) => item.blockNumber >= from && item.blockNumber <= to);
  return {ok: true, state: {from, to, items}};
}

export function visibleLogs(state) {
  if (state.from == null || state.to == null) return [];
  return state.items.filter((item) => item.blockNumber >= state.from && item.blockNumber <= state.to);
}

export function lookbackFloor(head) {
  return head > LOG_LOOKBACK ? head - LOG_LOOKBACK : 0n;
}

export function pruneLookback(state, head) {
  const lookback = lookbackFloor(head);
  if (state.from == null || state.to == null || state.to < lookback) return createLogCache();
  const to = state.to > head ? head : state.to;
  const from = state.from < lookback ? lookback : state.from;
  if (from > to) return createLogCache();
  return {
    from,
    to,
    items: state.items.filter((item) => item.blockNumber >= from && item.blockNumber <= to),
  };
}

export function planEventReads(state, head, cachedTo = state.to) {
  const lookback = lookbackFloor(head);
  // cachedTo is the tip before truncation. It decides a deep rollback only.
  const deepRollback = cachedTo != null && head + REORG_DEPTH < cachedTo;
  if (deepRollback || state.from == null || state.to == null || head < state.from || state.to < lookback) {
    return {lookback, pages: logWindows(lookback, head), reset: true};
  }
  const pages = [];
  const coveredTo = state.to < head ? state.to : head;
  const rewind = coveredTo > REORG_DEPTH ? coveredTo - REORG_DEPTH : 0n;
  let tipFrom = rewind < lookback ? lookback : rewind;
  if (tipFrom > head) tipFrom = head;
  // Oldest missing slice first, so a head jump larger than one page still touches coverage.
  pages.push(...logWindows(tipFrom, head).reverse());
  if (state.from > lookback) pages.push(...logWindows(lookback, state.from - 1n));
  return {lookback, pages, reset: false};
}

let cfg;
let A;
let AB;
let busy = false;
let runnerTask = null;
let logState = createLogCache();

export function resetLogCache() {
  logState = createLogCache();
}

export function logCoverage() {
  const items = visibleLogs(logState);
  let min = null;
  let max = null;
  for (const item of items) {
    if (min == null || item.blockNumber < min) min = item.blockNumber;
    if (max == null || item.blockNumber > max) max = item.blockNumber;
  }
  return {
    from: logState.from,
    to: logState.to,
    count: items.length,
    min,
    max,
    hashes: items.map((item) => item.transactionHash),
  };
}

export function seedLogCache(state) {
  logState = {
    from: state.from,
    to: state.to,
    items: state.items.map((item) => ({...item})),
  };
}

export function armTestBudget() {
  armBudget();
}

export function openSection(name) {
  return useSection(name);
}

export function enqueueRpc(method, params) {
  const budget = active;
  return spaced(async () => rpc(method, params, budget));
}

export function readLogWindow(addresses, fromBlock, toBlock, budget) {
  return getLogsRange(addresses, fromBlock, toBlock, budget || active);
}

export function useConfig(next) {
  requirePublicAddresses(next.addresses, 'Contract');
  requirePublicAddresses(next.wallets, 'Wallet');
  if (!next.abis || !Array.isArray(next.tiles)) throw new Error('Dashboard config is incomplete.');
  if (next.directory != null) requireDirectory(next);
  cfg = next;
  A = cfg.addresses;
  AB = cfg.abis;
}

function requireDirectory(next) {
  if (!Array.isArray(next.directory) || !next.directory.length) throw new Error('Dashboard directory is empty.');
  for (const item of next.directory) {
    const label = (item?.name || '') + (item?.group || '');
    if (!item || typeof item.name !== 'string' || !item.name.trim()) throw new Error('Directory contract name is missing.');
    if (typeof item.address !== 'string' || !ADDR.test(item.address)) throw new Error('Directory address is not public.');
    if (item.status !== 'current' && item.status !== 'older') throw new Error('Directory status must be current or older.');
    if (item.group != null && typeof item.group !== 'string') throw new Error('Directory group is not text.');
    if (item.abiKey != null && !next.abis[item.abiKey]) throw new Error('Directory contract has no ABI.');
    if (label.includes('\u2014') || label.includes('\u2013')) throw new Error('Directory text uses a dash that is not allowed.');
  }
}

function directoryEntries() {
  if (Array.isArray(cfg.directory) && cfg.directory.length) return cfg.directory;
  return Object.entries(A).map(([name, address]) => ({group: '', name: labelOf(name), address, status: 'current'}));
}

function statusCell(status) {
  return el('span', status === 'older' ? 'Older' : 'Current', status === 'older' ? 'older' : 'current');
}

function contractLabel(address) {
  const item = directoryEntries().find((row) => row.address.toLowerCase() === String(address).toLowerCase());
  if (item) return item.status === 'older' ? item.name + ' (older)' : item.name;
  const name = Object.keys(A).find((key) => A[key].toLowerCase() === String(address).toLowerCase());
  return labelOf(name || 'Contract');
}

function eventTargets() {
  const listed = directoryEntries().filter((item) => item.abiKey && AB[item.abiKey]).map((item) => item.address);
  const live = Object.keys(AB).filter((name) => name !== 'MUSDC' && A[name]).map((name) => A[name]);
  const seen = new Set();
  const out = [];
  for (const address of [...live, ...listed]) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function requirePublicAddresses(map, kind) {
  for (const [name, value] of Object.entries(map || {})) {
    if (typeof value !== 'string' || !ADDR.test(value)) {
      throw new Error(kind + ' ' + name + ' is not a public address.');
    }
  }
}

async function fetchBounded(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {cache: 'no-store', signal: controller.signal});
    const text = await response.text();
    return {ok: response.ok, status: response.status, text};
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /abort|timeout/i.test(error?.message || '')) {
      const timed = new Error('The file request timed out.');
      timed.cause = error;
      throw timed;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function loadConfig() {
  const response = await fetchBounded('./config.json', FILE_TIMEOUT_MS);
  if (!response.ok) throw new Error('Dashboard config did not load (' + response.status + ').');
  useConfig(JSON.parse(response.text));
}

function renderAddresses() {
  const rows = directoryEntries().map((item) => [
    item.group || '',
    item.name,
    statusCell(item.status),
    link('address', item.address, item.address),
  ]);
  table($('#addresses'), ['Set', 'Contract', 'Status', 'Base Sepolia explorer'], rows);
}

export function assembleOnchain({jobIds, records, services}) {
  let cursor = 0;
  const jobs = [];
  let jobsUnavailable = 0;
  const deals = [];
  let dealsUnavailable = 0;
  for (const id of jobIds) {
    const job = records[cursor] || {status: 'failure'};
    cursor += 1;
    const deal = records[cursor] || {status: 'failure'};
    cursor += 1;
    if (job.status === 'success') jobs.push({id, ...job.result});
    else jobsUnavailable += 1;
    if (deal.status !== 'success') dealsUnavailable += 1;
    else if (deal.result.fundedAt > 0n) deals.push({id, ...deal.result});
  }
  const serviceStats = [];
  let serviceUnavailable = 0;
  for (const service of services) {
    const items = [];
    let unavailable = 0;
    for (let index = 0; index < service.count; index += 1) {
      const row = records[cursor] || {status: 'failure'};
      cursor += 1;
      if (row.status !== 'success') {
        unavailable += 1;
        serviceUnavailable += 1;
        continue;
      }
      items.push(service.name === 'SP' ? row.result[2] : row.result);
    }
    serviceStats.push({name: service.name, read: items.length, unavailable, items});
  }
  const principal = deals.reduce((sum, deal) => sum + (deal.price || 0n), 0n);
  const partial = jobsUnavailable + dealsUnavailable + serviceUnavailable > 0;
  return {jobs, jobsUnavailable, deals, dealsUnavailable, principal, serviceStats, serviceUnavailable, partial};
}

export function assembleBreakaway(tiles, results) {
  const states = {};
  let seed = 0n;
  let stateUnavailable = 0;
  let auctionUnavailable = 0;
  const rows = tiles.map((tile, index) => {
    const state = results[index * 2] || {status: 'failure'};
    const auction = results[index * 2 + 1] || {status: 'failure'};
    const stateKnown = state.status === 'success';
    if (stateKnown) states[Number(state.result)] = (states[Number(state.result)] || 0) + 1;
    else stateUnavailable += 1;
    const data = auction.status === 'success' ? auction.result : null;
    if (data) seed += data[2] || 0n;
    else auctionUnavailable += 1;
    return {tile, stateKnown, stateValue: stateKnown ? Number(state.result) : null, data};
  });
  return {
    rows,
    states,
    seed,
    stateUnavailable,
    auctionUnavailable,
    partial: stateUnavailable + auctionUnavailable > 0,
  };
}

export function countWalletGaps(balances, practice) {
  let unavailable = 0;
  for (let index = 0; index < balances.length; index += 1) {
    if (balances[index] == null) unavailable += 1;
    if (!practice[index] || practice[index].status !== 'success') unavailable += 1;
  }
  return unavailable;
}

function onchainDetail(report, custodyUnavailable) {
  const bits = [];
  if (report.jobsUnavailable) bits.push(report.jobsUnavailable + ' jobs unavailable');
  if (report.dealsUnavailable) bits.push(report.dealsUnavailable + ' deals unavailable');
  if (report.serviceUnavailable) bits.push(report.serviceUnavailable + ' service records unavailable');
  if (custodyUnavailable) bits.push('a custody total was unavailable');
  return bits.join('. ') + '.';
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
      held?.status === 'success' ? num(held.result) + ' MUSDC' : 'Unavailable',
      ready?.status === 'success' ? num(ready.result) + ' MUSDC' : 'Unavailable',
    ];
  });
  const custodyUnavailable = serviceRows.some((row) => row[1] === 'Unavailable' || row[2] === 'Unavailable');
  const jobIds = idRange(nextJob);
  const servicePlan = ['SP', 'MT', 'ST'].map((name) => ({name, count: idRange(nextByService[name]).length}));
  const recordCalls = [
    ...jobIds.flatMap((id) => [call('JB', 'getJob', [id]), call('ESC', 'getDeal', [id])]),
    ...idRange(nextByService.SP).map((id) => call('SP', 'getDeal', [id])),
    ...idRange(nextByService.MT).map((id) => call('MT', 'meterOf', [id])),
    ...idRange(nextByService.ST).map((id) => call('ST', 'streamOf', [id])),
  ];
  const records = await multicall(recordCalls, blockNumber);
  const report = assembleOnchain({jobIds, records, services: servicePlan});
  const principalSub = report.dealsUnavailable
    ? 'Sum of funded job prices that were read. Unavailable deals: ' + report.dealsUnavailable + '. They are not in this sum.'
    : 'Sum of funded job prices that were read.';
  const cards = [
    ['Jobs', countLabel(report.jobs.length, report.jobsUnavailable), withGaps(stateSummary(report.jobs), report.jobsUnavailable, 'jobs')],
    ['Funded jobs', countLabel(report.deals.length, report.dealsUnavailable), withGaps(stateSummary(report.deals), report.dealsUnavailable, 'deals')],
    ['Job principal', num(report.principal) + ' MUSDC', principalSub],
  ];
  for (const service of report.serviceStats) {
    cards.push([
      labelOf(service.name) + ' records',
      countLabel(service.read, service.unavailable),
      withGaps(stateSummary(service.items), service.unavailable, 'records'),
    ]);
  }
  const metrics = $('#metrics');
  metrics.replaceChildren();
  for (const [title, value, sub] of cards) card(metrics, title, value, sub);
  let scope = "State numbers are the contracts' enum values. Job and service counts cover up to the latest " + idCap + " IDs per contract, not an unlimited history. These readings use the current contracts, including JobBoard v32.";
  if (report.partial || custodyUnavailable) scope += ' Unavailable records are counted apart from zero.';
  $('#scope').textContent = scope;
  table($('#custody'), ['Service', 'Held in active work', 'Ready to withdraw'], serviceRows);
  markRead('onchain-block', blockNumber);
  const partial = report.partial || custodyUnavailable;
  return {partial, detail: partial ? onchainDetail(report, custodyUnavailable) : ''};
}

function breakawayText(tileCount, report) {
  const summary = Object.entries(report.states).map(([key, count]) => 'state ' + key + ': ' + count).join(' · ');
  let text = tileCount + ' practice claims · ' + (summary || 'no state read') + ' · active seed ' + num(report.seed, 18) + ' test ETH';
  if (report.auctionUnavailable) {
    text += '. Unavailable auctions: ' + report.auctionUnavailable + '. Their bid seeds are not in the total.';
  }
  if (report.stateUnavailable) text += ' Unavailable states: ' + report.stateUnavailable + '.';
  return text;
}

async function loadBreakaway(blockNumber) {
  const calls = cfg.tiles.flatMap((tile) => [
    call('TileRegistry', 'getTileState', [tile]),
    call('DemoAuction', 'getAuction', [tile]),
  ]);
  const results = await multicall(calls, blockNumber);
  const report = assembleBreakaway(cfg.tiles, results);
  const rows = report.rows.map((row) => {
    const data = row.data;
    const close = !data ? 'Unavailable' : data[0] === 0n ? 'Not opened' : mt(data[0]);
    const leader = !data ? 'Unavailable' : isZero(data[1]) ? 'No bids' : link('address', data[1], small(data[1]));
    return [
      row.tile,
      row.stateKnown ? row.stateValue : 'Unavailable',
      close,
      leader,
      data ? num(data[2], 18) + ' test ETH' : 'Unavailable',
      data ? num(data[3], 18) + ' test ETH' : 'Unavailable',
    ];
  });
  $('#bkstats').textContent = breakawayText(cfg.tiles.length, report);
  table($('#claims'), ['Claim', 'State', 'Auction close (MT)', 'Leading wallet', 'Bid seed', 'Reserve'], rows);
  markRead('breakaway-block', blockNumber);
  const detail = report.partial
    ? report.auctionUnavailable + ' auctions unavailable. ' + report.stateUnavailable + ' states unavailable.'
    : '';
  return {partial: report.partial, detail};
}

async function loadWallets(blockNumber) {
  const budget = active;
  const entries = Object.entries(cfg.wallets);
  const balances = await Promise.all(entries.map(([, address]) => spaced(async () => {
    return BigInt(await rpc('eth_getBalance', [address, toHex(blockNumber)], budget));
  }).then((value) => value, () => null)));
  let practice;
  try {
    practice = await multicall(entries.map(([, address]) => call('MUSDC', 'balanceOf', [address])), blockNumber, budget);
  } catch (error) {
    if (!budgetSpent(error)) throw error;
    practice = entries.map(() => ({status: 'failure', error}));
  }
  const unavailable = countWalletGaps(balances, practice);
  const rows = entries.map(([name, address], index) => [
    name,
    link('address', address, small(address)),
    balances[index] == null ? 'Unavailable' : num(balances[index], 18) + ' test ETH',
    practice[index]?.status === 'success' ? num(practice[index].result) + ' MUSDC' : 'Unavailable',
  ]);
  table($('#wallets'), ['Agent wallet', 'Address', 'Gas balance', 'Practice balance'], rows);
  markRead('wallets-block', blockNumber);
  return {
    partial: unavailable > 0,
    detail: unavailable ? unavailable + ' wallet readings were unavailable.' : '',
  };
}

async function loadEvents(blockNumber) {
  const budget = active;
  const addresses = eventTargets();
  const originalTo = logState.to;
  const plan = planEventReads(logState, blockNumber, originalTo);
  if (plan.reset) logState = createLogCache();
  else if (originalTo != null && blockNumber < originalTo) logState = discardAboveHead(logState, blockNumber);
  if (!plan.reset) logState = pruneLookback(logState, blockNumber);
  let stoppedEarly = false;
  for (const [start, end] of plan.pages) {
    let logs;
    try {
      logs = await getLogsRange(addresses, start, end, budget);
    } catch (error) {
      if (!budgetSpent(error) && logState.from == null) throw error;
      stoppedEarly = true;
      break;
    }
    let committed = commitLogPage(logState, start, end, logs);
    if (!committed.ok) {
      committed = commitLogPage(createLogCache(), start, end, logs);
      logState = pruneLookback(committed.state, blockNumber);
      stoppedEarly = true;
      break;
    }
    logState = pruneLookback(committed.state, blockNumber);
  }
  if (logState.from == null || logState.to == null) {
    return {partial: true, detail: 'Recent events have not covered a block yet.'};
  }
  const partial = stoppedEarly || logState.from > plan.lookback || logState.to < blockNumber;
  const rows = [];
  const seen = new Set();
  const ordered = visibleLogs(logState).slice().sort((left, right) => Number(right.blockNumber - left.blockNumber) || Number(right.logIndex - left.logIndex));
  for (const log of ordered) {
    if (seen.has(log.transactionHash)) continue;
    seen.add(log.transactionHash);
    const listed = directoryEntries().find((row) => row.address.toLowerCase() === log.address.toLowerCase());
    const name = listed?.abiKey || Object.keys(A).find((key) => A[key].toLowerCase() === log.address.toLowerCase());
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
      contractLabel(log.address),
      event,
    ]);
    if (rows.length >= 30) break;
  }
  if (!rows.length) rows.push(['None', 'No contract events in the covered blocks', '', '']);
  table($('#recent'), ['Block', 'Transaction', 'Contract', 'Action event'], rows);
  markRead('events-block', logState.to);
  let scope = 'Covered blocks ' + logState.from + ' to ' + logState.to + '.';
  if (logState.from > plan.lookback || logState.to < blockNumber) {
    scope += ' Backfill target is ' + plan.lookback + ' to ' + blockNumber + '.';
  }
  scope += ' Missing blocks are filled from the covered edge. A short overlap is read again in case of a reorg. This is not a complete transaction history.';
  $('#eventscope').textContent = scope;
  return {
    partial,
    detail: partial ? 'Event backfill covers blocks ' + logState.from + ' to ' + logState.to + '.' : '',
  };
}

async function loadRunner() {
  const note = $('#runnernote');
  try {
    const response = await fetchBounded('./stats.json?at=' + Date.now(), FILE_TIMEOUT_MS);
    if (!response.ok) throw new Error('unavailable');
    const snapshot = JSON.parse(response.text);
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
  } catch (error) {
    if (/timed out/i.test(error?.message || '')) {
      note.textContent = 'Runner snapshot file timed out. Chain panels do not wait on it. No runner statistics are invented.';
      return;
    }
    note.textContent = 'Runner snapshot not published here. Chain panels read the public RPC separately. No runner statistics are invented.';
  }
}

function startRunner() {
  if (runnerTask) return;
  runnerTask = loadRunner().finally(() => {
    runnerTask = null;
  });
}

function tabHidden() {
  return document.visibilityState === 'hidden';
}

export async function refresh() {
  if (tabHidden()) return;
  if (busy) return;
  busy = true;
  $('#refresh').disabled = true;
  $('#error').textContent = '';
  $('#status').textContent = 'Reading public RPC…';
  armBudget();
  useSection('meta');
  startRunner();
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
    $('#network').textContent = 'Base Sepolia · chain 84532 · head block ' + blockNumber;
    const sections = [
      ['Project OnChain', 'onchain', () => loadOnchain(blockNumber)],
      ['Breakaway', 'breakaway', () => loadBreakaway(blockNumber)],
      ['Wallets', 'wallets', () => loadWallets(blockNumber)],
      ['Recent activity', 'events', () => loadEvents(blockNumber)],
    ];
    let allOk = true;
    for (const [name, section, run] of sections) {
      useSection(section);
      try {
        const result = await run();
        if (result?.partial) {
          allOk = false;
          problems.push(name + ': ' + result.detail);
        }
      } catch (error) {
        allOk = false;
        problems.push(name + ': ' + explain(error) + '.');
        if (name === 'Recent activity') {
          const scope = $('#eventscope');
          if (scope) scope.textContent = 'Recent events could not be read: ' + explain(error) + '. Earlier events stay in place.';
        }
      }
    }
    if (allOk) {
      $('#updated').textContent = 'Chain snapshot ' + mt(block.timestamp) + ' · block ' + blockNumber;
      $('#error').textContent = '';
      $('#status').textContent = 'Live snapshot complete';
    } else {
      $('#error').textContent = 'Refresh incomplete. ' + problems.join(' ') + ' Previously displayed values may be stale.';
      $('#status').textContent = 'Some readings are incomplete';
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
  document.addEventListener('visibilitychange', () => {
    if (!tabHidden()) refresh();
  });
  await refresh();
  setInterval(() => {
    if (tabHidden()) return;
    refresh();
  }, 60000);
}

if (typeof document !== 'undefined' && !globalThis.LIVE_DASHBOARD_TEST) await start();
