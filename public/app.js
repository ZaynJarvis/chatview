const app = document.querySelector('#app');

const state = {
  channels: [],
  activeChannelId: '',
  messages: [],
  nextCursor: null,
  channelState: null,
  stateLoading: false,
  stateError: '',
  reports: [],
  reportsLoading: false,
  reportsError: '',
  selectedReportId: '',
  loading: false,
  error: '',
  latestMessageTimestamp: null,
  priority: 'high',
  activeLayer: 'L2',
  starred: new Set(JSON.parse(localStorage.getItem('chatview.starred') || '[]')),
  sourceMessages: new Map(),
  highlightedMessageId: '',
  lightbox: '',
  expandedTargets: new Set(),
  forceL2ScrollTop: null
};

const priorityMeta = {
  high: { label: 'High', rank: 3 },
  normal: { label: 'Normal', rank: 2 },
  low: { label: 'Low', rank: 1 },
  ignore: { label: 'Ignore', rank: 0 }
};

const actionMeta = {
  buy: { label: 'BUY', text: '买入', tone: 'buy', rank: 6 },
  watch: { label: 'WATCH', text: '观察', tone: 'watch', rank: 5 },
  hold: { label: 'HOLD', text: '持有', tone: 'hold', rank: 4 },
  trim: { label: 'TRIM', text: '减仓', tone: 'sell', rank: 3 },
  sell: { label: 'SELL', text: '卖出', tone: 'sell', rank: 2 },
  avoid: { label: 'AVOID', text: '回避', tone: 'avoid', rank: 1 }
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function priorityLabel(priority) {
  return priorityMeta[priority]?.label || priority || 'Normal';
}

function compactText(value, fallback = 'No text content', max = 96) {
  const text = String(value || '').replace(/\s+/g, ' ').trim() || fallback;
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function formatTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(seconds * 1000));
}

function timestampDateTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString();
}

function lastUpdatedText() {
  const label = formatTimestamp(state.latestMessageTimestamp);
  return label ? `Last updated ${label}` : 'Last updated --';
}

function latestTimestampFromMessages(messages = []) {
  return messages.reduce((latest, message) => {
    const timestamp = Number(message?.timestamp || 0);
    return Number.isFinite(timestamp) && timestamp > latest ? timestamp : latest;
  }, 0) || null;
}

function safeHref(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, window.location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    return '';
  }
  return '';
}

function markdownImageUrls(value) {
  const urls = [];
  const pattern = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of String(value || '').matchAll(pattern)) {
    const href = safeHref(match[1]);
    if (href) urls.push(href);
  }
  return urls;
}

function isLocalChatlogImageHref(value) {
  try {
    const url = new URL(value, window.location.origin);
    return ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.includes('/image/');
  } catch {
    return false;
  }
}

function markdownImageMarkup(alt, href) {
  const safe = safeHref(href);
  if (!safe) return '';
  if (isLocalChatlogImageHref(safe)) {
    return `<span class="image-pending">${escapeHtml(alt || 'image')} pending upload</span>`;
  }
  const label = alt || 'image';
  return `
    <button class="thumb markdown-thumb" data-action="lightbox" data-src="${escapeHtml(safe)}">
      <img src="${escapeHtml(safe)}" alt="${escapeHtml(label)}">
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/(^|[^!])\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, prefix, label, href) => {
      const safe = safeHref(href.replace(/&amp;/g, '&'));
      return safe ? `${prefix}<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${label}</a>` : `${prefix}${label}`;
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function markdownMarkup(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const parts = [];
  let list = [];

  function flushList() {
    if (!list.length) return;
    parts.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);
    list = [];
  }

  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function isTableSeparator(line) {
    const cells = splitTableRow(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function tableMarkup(startIndex) {
    const header = splitTableRow(lines[startIndex]);
    if (header.length < 2 || !isTableSeparator(lines[startIndex + 1] || '')) return null;

    const rows = [];
    let cursor = startIndex + 2;
    while (cursor < lines.length) {
      const rowLine = lines[cursor].trim();
      if (!rowLine || !rowLine.includes('|')) break;
      const cells = splitTableRow(rowLine);
      if (cells.length < 2) break;
      rows.push(cells);
      cursor += 1;
    }

    return {
      nextIndex: cursor - 1,
      html: `
        <div class="table-scroll">
          <table class="markdown-table">
            <thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead>
            <tbody>
              ${rows.map((row) => `
                <tr>${header.map((_, index) => `<td>${inlineMarkdown(row[index] || '')}</td>`).join('')}</tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `
    };
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    const table = tableMarkup(index);
    if (table) {
      flushList();
      parts.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const image = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
    if (image) {
      flushList();
      parts.push(markdownImageMarkup(image[1] || 'image', image[2]));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = Math.min(5, heading[1].length + 2);
      parts.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      list.push(listItem[1]);
      continue;
    }

    const quote = line.match(/^>\s+(.+)$/);
    if (quote) {
      flushList();
      parts.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    flushList();
    parts.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  flushList();
  return parts.length ? parts.join('') : '<p class="muted">No markdown content.</p>';
}

function avatarClass(message) {
  let hash = 0;
  for (const ch of message.username || message.external_id) hash = (hash + ch.charCodeAt(0)) % 8;
  return `av-${hash + 1}`;
}

function persistSets() {
  localStorage.setItem('chatview.starred', JSON.stringify([...state.starred]));
}

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function writeApiKey() {
  let key = localStorage.getItem('chatview.apiKey') || '';
  if (!key) {
    key = window.prompt('ChatView API key') || '';
    if (key) localStorage.setItem('chatview.apiKey', key);
  }
  return key;
}

async function writeApi(path, options = {}) {
  const key = writeApiKey();
  if (!key) throw new Error('API key required');
  const res = await fetch(path, {
    ...options,
    headers: {
      accept: 'application/json',
      'x-api-key': key,
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) localStorage.removeItem('chatview.apiKey');
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

function cacheMessages(messages = []) {
  for (const message of messages) {
    if (message?.external_id) state.sourceMessages.set(message.external_id, message);
  }
}

function mergeMessages(existing = [], incoming = []) {
  const byId = new Map();
  for (const message of existing) {
    if (message?.external_id) byId.set(message.external_id, message);
  }
  for (const message of incoming) {
    if (message?.external_id) byId.set(message.external_id, message);
  }
  return [...byId.values()]
    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)
      || String(b.external_id || '').localeCompare(String(a.external_id || '')));
}

function sourceIdsForState(snapshot) {
  const ids = new Set();
  for (const card of snapshot?.cards || []) {
    for (const id of card.message_ids || []) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function sourceIdsForReport(report) {
  return (report?.source_message_ids || []).filter(Boolean);
}

function compactList(value) {
  if (value == null) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function compactCellText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (actionMeta[raw]) return raw;
  if (/avoid|回避|不碰|别碰/.test(raw)) return 'avoid';
  if (/sell|卖|清仓/.test(raw)) return 'sell';
  if (/trim|减|降仓/.test(raw)) return 'trim';
  if (/buy|买|加仓|偏多|做多|回踩买/.test(raw)) return 'buy';
  if (/hold|持有|拿着/.test(raw)) return 'hold';
  return 'watch';
}

function scoreFromActionText(value) {
  const raw = String(value || '').toLowerCase();
  if (/avoid|回避|不碰|别碰/.test(raw)) return 8;
  if (/sell|卖|清仓/.test(raw)) return 12;
  if (/trim|减|降仓/.test(raw)) return 24;
  if (/回踩买|买|加仓/.test(raw)) return 84;
  if (/偏多|做多/.test(raw)) return 76;
  if (/hold|持有|拿着/.test(raw)) return 58;
  if (/观察|watch|试错|等|确认/.test(raw)) return 46;
  return 34;
}

function actionLabel(action) {
  return actionMeta[action]?.label || String(action || 'WATCH').toUpperCase();
}

function actionText(action) {
  return actionMeta[action]?.text || '观察';
}

function markdownTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => compactCellText(cell));
}

function isMarkdownTableSeparator(line) {
  const cells = markdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function firstMarkdownTable(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes('|') || !isMarkdownTableSeparator(lines[index + 1] || '')) continue;
    const header = markdownTableRow(lines[index]);
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim().includes('|')) {
      rows.push(markdownTableRow(lines[cursor]));
      cursor += 1;
    }
    return { lines, start: index, end: cursor - 1, header, rows };
  }
  return null;
}

function cellByHeader(row, header, names) {
  for (const name of names) {
    const index = header.findIndex((cell) => cell.includes(name));
    if (index >= 0) return row[index] || '';
  }
  return '';
}

function parseMarkdownTargets(report) {
  const table = firstMarkdownTable(report.markdown);
  if (!table) return [];
  const hasTargetColumn = table.header.some((cell) => cell.includes('标的'));
  if (!hasTargetColumn) return [];
  return table.rows.map((row) => {
    const symbol = cellByHeader(row, table.header, ['标的', 'Ticker']).replace(/\s+/g, '').toUpperCase();
    const direction = cellByHeader(row, table.header, ['方向', '动作']);
    const reason = cellByHeader(row, table.header, ['触发因素', '原因', '催化']);
    const risk = cellByHeader(row, table.header, ['风险/失效', '风险', '失效']);
    const shortTerm = cellByHeader(row, table.header, ['短线动作', '短线']);
    const longTerm = cellByHeader(row, table.header, ['中线动作', '长线动作', '中线', '长线']);
    const action = canonicalAction(`${direction} ${shortTerm} ${longTerm}`);
    return {
      symbol,
      name: '',
      industry: '',
      description: compactText(reason || direction, '', 56),
      primary_action: action,
      action_summary: direction || actionText(action),
      buy_score: scoreFromActionText(`${direction} ${shortTerm} ${longTerm}`),
      short_term: shortTerm,
      long_term: longTerm,
      core_points: [direction, reason].filter(Boolean).slice(0, 2),
      reasons: reason ? [reason] : [],
      risks: risk ? [risk] : [],
      invalidation: risk,
      details: '',
      source_message_ids: sourceIdsForReport(report),
      source: 'markdown'
    };
  }).filter((target) => target.symbol || target.action_summary);
}

function normalizeReportTargets(report) {
  const structured = (report.targets || []).map((target) => {
    const action = canonicalAction(target.primary_action || target.action_summary);
    return {
      symbol: String(target.symbol || '').trim().toUpperCase(),
      name: String(target.name || '').trim(),
      industry: String(target.industry || '').trim(),
      description: String(target.description || '').trim(),
      primary_action: action,
      action_summary: String(target.action_summary || actionText(action)).trim(),
      buy_score: Number.isFinite(Number(target.buy_score)) ? Number(target.buy_score) : scoreFromActionText(target.action_summary),
      short_term: String(target.short_term || '').trim(),
      long_term: String(target.long_term || '').trim(),
      core_points: compactList(target.core_points).slice(0, 4),
      reasons: compactList(target.reasons).slice(0, 4),
      risks: compactList(target.risks).slice(0, 4),
      invalidation: String(target.invalidation || '').trim(),
      details: String(target.details || '').trim(),
      source_message_ids: compactList(target.source_message_ids),
      source: 'structured'
    };
  }).filter((target) => target.symbol || target.name || target.action_summary);

  const targets = structured.length ? structured : parseMarkdownTargets(report);
  return targets
    .map((target, index) => ({ ...target, original_index: index }))
    .sort((a, b) =>
      Number(b.buy_score || 0) - Number(a.buy_score || 0) ||
      (actionMeta[b.primary_action]?.rank || 0) - (actionMeta[a.primary_action]?.rank || 0) ||
      a.original_index - b.original_index
    );
}

function markdownWithoutConclusionTable(markdown) {
  const table = firstMarkdownTable(markdown);
  if (!table) return String(markdown || '').trim();
  let start = table.start;
  for (let index = table.start - 1; index >= 0; index -= 1) {
    const line = table.lines[index].trim();
    if (!line) {
      start = index;
      continue;
    }
    if (/^#{1,4}\s+个股结论/.test(line)) start = index;
    break;
  }
  return [
    ...table.lines.slice(0, start),
    ...table.lines.slice(table.end + 1)
  ].join('\n').trim();
}

function targetKey(report, target, index) {
  return `${report.report_id}:${target.symbol || target.name || 'target'}:${index}`;
}

function messageById(externalId) {
  return state.messages.find((message) => message.external_id === externalId)
    || state.sourceMessages.get(externalId)
    || null;
}

async function fetchMessage(externalId) {
  const data = await api(`/api/messages/${encodeURIComponent(externalId)}`);
  cacheMessages([data.message]);
  return data.message;
}

async function hydrateSourceMessages(snapshot) {
  const missing = sourceIdsForState(snapshot).filter((id) => !messageById(id));
  await Promise.allSettled(missing.map(async (id) => {
    try {
      await fetchMessage(id);
    } catch {
      state.sourceMessages.set(id, {
        external_id: id,
        username: 'Unavailable',
        content: 'Message not found',
        priority: 'ignore',
        missing: true
      });
    }
  }));
}

async function hydrateReportSourceMessages(report) {
  const missing = sourceIdsForReport(report).slice(0, 12).filter((id) => !messageById(id));
  await Promise.allSettled(missing.map(async (id) => {
    try {
      await fetchMessage(id);
    } catch {
      state.sourceMessages.set(id, {
        external_id: id,
        username: 'Unavailable',
        content: 'Message not found',
        priority: 'ignore',
        missing: true
      });
    }
  }));
}

async function loadChannels() {
  const data = await api('/api/channels');
  state.channels = data.channels || [];
  if (!state.activeChannelId && state.channels[0]) {
    state.activeChannelId = state.channels[0].channel_id;
  }
}

function messageQuery(reset = false) {
  const params = new URLSearchParams();
  params.set('limit', '50');
  if (state.activeChannelId) params.set('channel_id', state.activeChannelId);
  if (state.priority) params.set('priority', state.priority);
  if (!reset && state.nextCursor) params.set('cursor', state.nextCursor);
  return `/api/messages?${params.toString()}`;
}

async function loadMessages({ reset = false } = {}) {
  if (state.loading || (!reset && !state.nextCursor)) return;
  state.loading = true;
  state.error = '';
  if (reset) state.forceL2ScrollTop = 0;
  render();
  try {
    const data = await api(messageQuery(reset));
    state.messages = reset ? data.messages || [] : mergeMessages(state.messages, data.messages || []);
    cacheMessages(data.messages || []);
    state.nextCursor = data.next_cursor || null;
    const latest = Number(data.latest_message_timestamp || latestTimestampFromMessages(state.messages));
    state.latestMessageTimestamp = Number.isFinite(latest) && latest > 0 ? latest : null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function loadChannelState() {
  if (!state.activeChannelId) {
    state.channelState = null;
    return;
  }

  state.stateLoading = true;
  state.stateError = '';
  render();
  try {
    const params = new URLSearchParams({ channel_id: state.activeChannelId, level: 'L1', card_limit: '10' });
    const data = await api(`/api/channel-state?${params.toString()}`);
    state.channelState = data.state || null;
    if (state.channelState) await hydrateSourceMessages(state.channelState);
  } catch (error) {
    state.channelState = null;
    state.stateError = error.message;
  } finally {
    state.stateLoading = false;
    render();
  }
}

async function loadReports() {
  state.reportsLoading = true;
  state.reportsError = '';
  render();
  try {
    const params = new URLSearchParams({ level: 'L0', limit: '8' });
    if (state.activeChannelId) params.set('channel_id', state.activeChannelId);
    const data = await api(`/api/reports?${params.toString()}`);
    state.reports = data.reports || [];
    if (!state.reports.some((report) => report.report_id === state.selectedReportId)) {
      state.selectedReportId = state.reports[0]?.report_id || '';
    }
    if (state.selectedReportId) await hydrateReportSourceMessages(activeReport());
  } catch (error) {
    state.reports = [];
    state.selectedReportId = '';
    state.reportsError = error.message;
  } finally {
    state.reportsLoading = false;
    render();
  }
}

async function focusSourceMessage(externalId) {
  let message = messageById(externalId);
  try {
    if (!message || message.missing) message = await fetchMessage(externalId);
  } catch (error) {
    state.stateError = error.message;
    render();
    return;
  }

  if (!state.messages.some((item) => item.external_id === externalId)) {
    state.messages = [message, ...state.messages]
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
  }

  state.priority = '';
  state.highlightedMessageId = externalId;
  state.activeLayer = 'L2';
  render();

  requestAnimationFrame(() => {
    const row = [...document.querySelectorAll('[data-message-id]')]
      .find((element) => element.dataset.messageId === externalId);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

function activeChannel() {
  return state.channels.find((channel) => channel.channel_id === state.activeChannelId) || state.channels[0];
}

function activeReport() {
  if (!state.selectedReportId) return null;
  return state.reports.find((report) => report.report_id === state.selectedReportId) || null;
}

async function deleteCurrentState() {
  const snapshot = state.channelState;
  if (!snapshot?.state_id) return;
  if (!window.confirm(`Delete L1 state ${snapshot.state_id}?`)) return;
  try {
    await writeApi(`/api/channel-state/${encodeURIComponent(snapshot.state_id)}`, { method: 'DELETE' });
    state.channelState = null;
    await loadChannelState();
  } catch (error) {
    state.stateError = error.message;
    render();
  }
}

async function deleteCurrentReport() {
  const report = activeReport();
  if (!report?.report_id) return;
  if (!window.confirm(`Delete L0 report ${report.report_id}?`)) return;
  try {
    await writeApi(`/api/reports/${encodeURIComponent(report.report_id)}`, { method: 'DELETE' });
    state.reports = state.reports.filter((item) => item.report_id !== report.report_id);
    state.selectedReportId = state.reports[0]?.report_id || '';
    await loadReports();
  } catch (error) {
    state.reportsError = error.message;
    render();
  }
}

function visibleMessages() {
  return state.messages;
}

function channelMarkup() {
  return state.channels.map((channel) => `
    <button class="channel-chip ${channel.channel_id === state.activeChannelId ? 'active' : ''}"
      data-action="channel" data-channel-id="${escapeHtml(channel.channel_id)}">
      <span class="channel-icon">${escapeHtml(channel.channel.slice(0, 1))}</span>
      <span class="channel-name">${escapeHtml(channel.channel)}</span>
      <span class="channel-count">${channel.message_count}</span>
    </button>
  `).join('');
}

function priorityFilterMarkup() {
  const isHighOnly = state.priority === 'high';
  return `
    <div class="priority-filter" aria-label="Message priority filter">
      <button class="header-button ${isHighOnly ? 'on' : ''}"
        data-action="priority-filter" aria-pressed="${isHighOnly ? 'true' : 'false'}"
        title="${isHighOnly ? 'Showing high priority only' : 'Showing high and low priority'}">
        High
      </button>
    </div>
  `;
}

async function refreshAll() {
  await loadChannels();
  await Promise.all([
    loadMessages({ reset: true }),
    loadChannelState(),
    loadReports()
  ]);
}

function topbarMarkup() {
  return `
    <header class="topbar" data-action="scroll-latest" title="Jump to latest messages">
      <div class="brand" aria-label="ChatView">
        <span class="brand-mark"></span>
        <span>ChatView</span>
        <small>L2 live</small>
      </div>
      <nav class="channels" aria-label="Channels">${channelMarkup()}</nav>
      <div class="topbar-right">
        <span class="sync-stamp" title="${escapeHtml(lastUpdatedText())}">${escapeHtml(lastUpdatedText())}</span>
        <button class="header-button" data-action="refresh-all" ${state.loading || state.stateLoading || state.reportsLoading ? 'disabled' : ''}>Refresh</button>
        ${priorityFilterMarkup()}
        <label class="search-box disabled" aria-disabled="true" title="Search is disabled">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5"></circle><path d="m11 11 3 3"></path></svg>
          <input type="search" value="" placeholder="Search" disabled>
        </label>
      </div>
    </header>
  `;
}

function tabsMarkup() {
  const tabs = [
    ['L2', 'Messages', state.messages.length],
    ['L1', 'State', state.channelState ? Math.max(1, state.channelState.cards?.length || 0) : 0],
    ['L0', 'Reports', state.reports.length]
  ];
  return `
    <div class="layer-tabs" role="tablist">
      ${tabs.map(([id, label, count]) => `
        <button class="layer-tab ${state.activeLayer === id ? 'active' : ''}" data-action="layer" data-layer="${id}">
          <span class="lt-eyebrow">${id}</span>
          <span class="lt-label">${label}</span>
          <span class="lt-count">${count}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function messageMarkup(message) {
  const isStarred = state.starred.has(message.external_id);
  const contentImageUrls = new Set(markdownImageUrls(message.content));
  const imageHref = safeHref(message.image_url);
  const showStandaloneImage = imageHref && !contentImageUrls.has(imageHref);
  const timestamp = formatTimestamp(message.timestamp);
  const dateTime = timestampDateTime(message.timestamp);
  const classes = [
    'message',
    `priority-${message.priority}`,
    isStarred ? 'starred' : '',
    state.highlightedMessageId === message.external_id ? 'highlighted' : ''
  ].filter(Boolean).join(' ');

  return `
    <article class="${classes}" data-message-id="${escapeHtml(message.external_id)}">
      <div class="message-main">
        <div class="message-head">
          <div class="message-author">
            <strong>${escapeHtml(message.username)}</strong>
            ${timestamp ? `<time class="message-time" datetime="${escapeHtml(dateTime)}">${escapeHtml(timestamp)}</time>` : ''}
          </div>
          <button class="star-button ${isStarred ? 'on' : ''}" title="Favorite" data-action="star" data-external-id="${escapeHtml(message.external_id)}">
            ${isStarred ? '★' : '☆'}
          </button>
        </div>
        ${message.content ? `<div class="message-text message-markdown">${markdownMarkup(message.content)}</div>` : '<p class="message-text muted">No text content</p>'}
        ${showStandaloneImage ? `
          <button class="thumb" data-action="lightbox" data-src="${escapeHtml(imageHref)}">
            <img src="${escapeHtml(imageHref)}" alt="">
            <span>image_url</span>
          </button>
        ` : ''}
      </div>
    </article>
  `;
}

function sourceMessageMarkup(externalId) {
  const message = messageById(externalId);
  if (!message) return '<button class="source-link loading" disabled>Loading source message...</button>';

  const fallback = message.image_url ? 'Image message' : 'No text content';
  return `
    <button class="source-link ${message.missing ? 'missing' : ''}"
      data-action="source-message" data-external-id="${escapeHtml(externalId)}"
      ${message.missing ? 'disabled' : ''}>
      <strong>${escapeHtml(message.username || 'Unknown')}</strong>
      <span>${escapeHtml(compactText(message.content, fallback))}</span>
    </button>
  `;
}

function cardSourcesMarkup(card) {
  const ids = card.message_ids || [];
  if (!ids.length) return '';
  const visibleIds = ids.slice(0, 4);
  const hiddenCount = ids.length - visibleIds.length;
  return `
    <div class="source-list">
      ${visibleIds.map(sourceMessageMarkup).join('')}
      ${hiddenCount > 0 ? `<span class="source-more">+${hiddenCount} more source messages</span>` : ''}
    </div>
  `;
}

function l2Markup() {
  const channel = activeChannel();
  const visible = visibleMessages();

  return `
    <section class="column l2 ${state.activeLayer === 'L2' ? 'active-layer' : ''}">
      <div class="column-head">
        <div class="column-title"><b>L2</b> Raw messages</div>
        <h1>${escapeHtml(channel?.channel || 'No channel')}</h1>
        <p>${channel?.message_count || 0} total messages · ${state.messages.length} loaded · ${escapeHtml(lastUpdatedText())}</p>
      </div>
      <div class="column-body">
        ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
        <div class="message-list">
          ${visible.map(messageMarkup).join('')}
        </div>
        ${state.loading ? '<div class="status">Loading...</div>' : ''}
        ${!state.loading && visible.length === 0 ? '<div class="empty">No messages match this view.</div>' : ''}
        <div class="scroll-sentinel" aria-hidden="true"></div>
      </div>
    </section>
  `;
}

function l1Markup() {
  const channel = activeChannel();
  const snapshot = state.channelState;
  const cards = snapshot?.cards || [];
  const totalCards = snapshot?.compact?.cards_total || cards.length;
  const cardNote = snapshot && totalCards > cards.length ? `${cards.length}/${totalCards} cards` : `${cards.length} cards`;

  return `
    <section class="column l1 ${state.activeLayer === 'L1' ? 'active-layer' : ''}">
      <div class="column-head">
        <div class="column-title"><b>L1</b> Aggregated insights</div>
        <h1>${snapshot ? 'Channel state' : 'No L1 state'}</h1>
        <p>${escapeHtml(channel?.channel || 'selected channel')}</p>
      </div>
      <div class="toolbar">
        <button class="danger" data-action="delete-state" ${snapshot?.state_id ? '' : 'disabled'}>Delete state</button>
        <span class="toolbar-note">${snapshot ? cardNote : 'waiting for API state'}</span>
      </div>
      <div class="column-body">
        ${state.stateError ? `<div class="error">${escapeHtml(state.stateError)}</div>` : ''}
        ${state.stateLoading ? '<div class="status">Loading L1 state...</div>' : ''}
        ${!state.stateLoading && !snapshot ? `
          <div class="empty-panel">
            <span class="panel-kicker">L1 state</span>
            <h2>No saved state for this channel</h2>
            <p>When <code>POST /api/channel-state</code> receives an L1 snapshot, it will appear here with cards, markdown, and source links.</p>
          </div>
        ` : ''}
        ${snapshot ? `
          <article class="state-summary">
            <span class="panel-kicker">L1 state</span>
            <div class="markdown-body">${markdownMarkup(snapshot.markdown)}</div>
          </article>
          ${cards.length ? `
            <div class="insight-list">
              ${cards.map((card) => `
                <article class="insight-card priority-${escapeHtml(card.priority || 'normal')}">
                  <div class="insight-head">
                    <h3>${escapeHtml(card.title || 'Untitled insight')}</h3>
                    <span class="priority-badge ${escapeHtml(card.priority || 'normal')}">${escapeHtml(priorityLabel(card.priority || 'normal'))}</span>
                  </div>
                  <p>${escapeHtml(card.body || '')}</p>
                  ${cardSourcesMarkup(card)}
                </article>
              `).join('')}
            </div>
          ` : '<div class="empty inline-empty">No cards in this state.</div>'}
        ` : ''}
      </div>
    </section>
  `;
}

function reportSourcesMarkup(report) {
  const ids = sourceIdsForReport(report);
  if (!ids.length) return '';
  const visibleIds = ids.slice(0, 8);
  const hiddenCount = ids.length - visibleIds.length;
  return `
    <div class="report-source-list" data-report-source-list>
      ${visibleIds.map(sourceMessageMarkup).join('')}
      ${hiddenCount > 0 ? `<span class="source-more">+${hiddenCount} more source messages</span>` : ''}
    </div>
  `;
}

function targetListMarkup(title, items) {
  if (!items.length) return '';
  return `
    <section class="target-detail-section">
      <h4>${escapeHtml(title)}</h4>
      <ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>
    </section>
  `;
}

function targetCardMarkup(report, target, index) {
  const key = targetKey(report, target, index);
  const expanded = state.expandedTargets.has(key);
  const title = [target.symbol, target.name].filter(Boolean).join(' · ') || `标的 ${index + 1}`;
  const description = target.description || target.industry || '暂无行业描述';
  const action = target.primary_action || 'watch';
  const tone = actionMeta[action]?.tone || 'watch';
  const corePoints = target.core_points.length ? target.core_points : [target.action_summary].filter(Boolean);
  const detailsMarkup = [
    targetListMarkup('原因', target.reasons),
    targetListMarkup('风险', target.risks),
    target.invalidation ? `
      <section class="target-detail-section">
        <h4>失效条件</h4>
        <p>${inlineMarkdown(target.invalidation)}</p>
      </section>
    ` : '',
    target.details ? `
      <section class="target-detail-section">
        <h4>分析</h4>
        <p>${inlineMarkdown(target.details)}</p>
      </section>
    ` : ''
  ].join('');
  return `
    <article class="target-card ${expanded ? 'expanded' : ''}" data-target-card data-target-key="${escapeHtml(key)}">
      <button class="target-toggle" data-action="toggle-target" data-target-key="${escapeHtml(key)}"
        data-expanded="${expanded ? 'true' : 'false'}" aria-expanded="${expanded ? 'true' : 'false'}">
        <span class="target-rank">${index + 1}</span>
        <span class="target-main">
          <span class="target-title">${escapeHtml(title)}</span>
          <span class="target-desc">${escapeHtml(description)}</span>
        </span>
        <span class="target-action ${escapeHtml(tone)}">
          <span>${escapeHtml(actionLabel(action))}</span>
          <strong>${escapeHtml(target.buy_score || target.buy_score === 0 ? Math.round(target.buy_score) : '--')}</strong>
        </span>
      </button>
      <div class="target-core">
        <div class="target-action-line">
          <span>动作</span>
          <strong>${escapeHtml(target.action_summary || actionText(action))}</strong>
        </div>
        <div class="target-horizon">
          ${target.short_term ? `<span><b>短线</b>${escapeHtml(target.short_term)}</span>` : ''}
          ${target.long_term ? `<span><b>长线</b>${escapeHtml(target.long_term)}</span>` : ''}
        </div>
        ${corePoints.length ? `<ul class="target-core-points">${corePoints.map((point) => `<li>${inlineMarkdown(point)}</li>`).join('')}</ul>` : ''}
      </div>
      ${detailsMarkup.trim() ? `<div class="target-details" data-target-details ${expanded ? '' : 'hidden'}>${detailsMarkup}</div>` : ''}
    </article>
  `;
}

function reportCardMarkup(report, selected) {
  const expanded = selected?.report_id === report.report_id;
  const topics = report.topics || [];
  const references = report.references || [];
  const targets = normalizeReportTargets(report);
  const detailMarkdown = targets.some((target) => target.source === 'markdown')
    ? markdownWithoutConclusionTable(report.markdown)
    : String(report.markdown || '').trim();
  return `
    <article class="report-card ${expanded ? 'expanded' : ''}" data-report-card data-report-id="${escapeHtml(report.report_id)}">
      <button class="report-toggle" data-action="toggle-report" data-report-id="${escapeHtml(report.report_id)}"
        aria-expanded="${expanded ? 'true' : 'false'}">
        <span class="report-toggle-main">
          <span class="report-title">${escapeHtml(report.title || 'Untitled report')}</span>
          ${report.summary ? `<span class="report-summary">${escapeHtml(compactText(report.summary, '', 132))}</span>` : ''}
        </span>
        <span class="report-meta">
          <span>${escapeHtml(formatTimestamp(report.window_end) || '')}</span>
          <span>${(report.source_message_ids || []).length} msg</span>
        </span>
      </button>
      <div class="report-expanded" data-report-expanded ${expanded ? '' : 'hidden'}>
        ${topics.length ? `<div class="topic-tags">${topics.map((topic) => `<span>${escapeHtml(topic)}</span>`).join('')}</div>` : ''}
        ${targets.length ? `
          <div class="target-stack">
            ${targets.map((target, index) => targetCardMarkup(report, target, index)).join('')}
          </div>
        ` : ''}
        ${detailMarkdown ? `
          <section class="report-detail-block">
            <h3>详情</h3>
            <div class="markdown-body">${markdownMarkup(detailMarkdown)}</div>
          </section>
        ` : targets.length ? '' : `<div class="markdown-body">${markdownMarkup(report.markdown)}</div>`}
        ${references.length ? `
          <h3>References</h3>
          <div class="reference-list">
            ${references.map((reference) => {
              const href = safeHref(reference.url);
              const label = reference.title || reference.url || 'Reference';
              return href
                ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
                : `<span>${escapeHtml(label)}</span>`;
            }).join('')}
          </div>
        ` : ''}
        ${reportSourcesMarkup(report)}
      </div>
    </article>
  `;
}

function l0Markup() {
  const channel = activeChannel();
  const isSlock = state.activeChannelId === '45271353210@chatroom';
  const selected = activeReport();
  const reportNote = state.reports.length === 1 ? '1 hourly brief' : `${state.reports.length} hourly briefs`;
  return `
    <section class="column l0 ${state.activeLayer === 'L0' ? 'active-layer' : ''}">
      <div class="column-head">
        <div class="column-title"><b>L0</b> ${isSlock ? 'AI brief' : 'Action layer'}</div>
        <h1>${isSlock ? 'AI 群聊摘要' : 'Investment actions'}</h1>
        <p>${escapeHtml(channel?.channel || 'selected channel')} · ${state.reports.length} loaded</p>
      </div>
      <div class="toolbar">
        <button class="danger" data-action="delete-report" ${selected?.report_id ? '' : 'disabled'}>Delete report</button>
        <span class="toolbar-note">${reportNote}</span>
      </div>
      <div class="column-body">
        ${state.reportsError ? `<div class="error">${escapeHtml(state.reportsError)}</div>` : ''}
        ${state.reportsLoading ? '<div class="status">Loading reports...</div>' : ''}
        ${!state.reportsLoading && state.reports.length === 0 ? `
          <div class="empty-panel">
            <span class="panel-kicker">L0 reports</span>
            <h2>No reports for this channel</h2>
            <p>Reports created through <code>POST /api/reports</code> will appear newest first with the markdown body and references.</p>
          </div>
        ` : ''}
        ${state.reports.length ? `
          <div class="report-stack">
            ${state.reports.map((report) => reportCardMarkup(report, selected)).join('')}
          </div>
        ` : ''}
      </div>
    </section>
  `;
}

function lightboxMarkup() {
  if (!state.lightbox) return '';
  return `
    <div class="lightbox" data-action="close-lightbox">
      <img src="${escapeHtml(state.lightbox)}" alt="">
    </div>
  `;
}

function render() {
  const previousL2Body = document.querySelector('.l2 .column-body');
  const previousL2ScrollTop = previousL2Body ? previousL2Body.scrollTop : 0;
  app.innerHTML = `
    ${topbarMarkup()}
    ${tabsMarkup()}
    <main class="columns">
      ${l2Markup()}
      ${l1Markup()}
      ${l0Markup()}
    </main>
    ${lightboxMarkup()}
  `;
  requestAnimationFrame(() => {
    const nextL2Body = document.querySelector('.l2 .column-body');
    if (nextL2Body) {
      nextL2Body.scrollTop = state.forceL2ScrollTop ?? previousL2ScrollTop;
      state.forceL2ScrollTop = null;
    }
  });
}

function scrollToLatestMessages() {
  state.activeLayer = 'L2';
  state.forceL2ScrollTop = 0;
  render();
  requestAnimationFrame(() => {
    document.querySelector('.l2 .column-body')?.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function setReportExpanded(card, expanded) {
  card.classList.toggle('expanded', expanded);
  const toggle = card.querySelector('[data-action="toggle-report"]');
  if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  const body = card.querySelector('[data-report-expanded]');
  if (body) body.hidden = !expanded;
}

function syncReportExpansion() {
  for (const card of document.querySelectorAll('[data-report-card]')) {
    setReportExpanded(card, card.dataset.reportId === state.selectedReportId);
  }
}

function refreshReportSourceList(reportId) {
  const report = state.reports.find((item) => item.report_id === reportId);
  if (!report) return;
  for (const card of document.querySelectorAll('[data-report-card]')) {
    if (card.dataset.reportId !== reportId) continue;
    const sourceList = card.querySelector('[data-report-source-list]');
    if (sourceList) sourceList.outerHTML = reportSourcesMarkup(report) || '';
  }
}

function setTargetExpanded(card, expanded) {
  card.classList.toggle('expanded', expanded);
  const toggle = card.querySelector('[data-action="toggle-target"]');
  if (toggle) {
    toggle.dataset.expanded = expanded ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
  const details = card.querySelector('[data-target-details]');
  if (details) details.hidden = !expanded;
}

app.addEventListener('scroll', async (event) => {
  const scroller = event.target;
  if (!(scroller instanceof HTMLElement) || !scroller.matches('.l2 .column-body')) return;
  const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (remaining < 360) await loadMessages();
}, true);

app.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  if (action === 'scroll-latest') {
    scrollToLatestMessages();
    return;
  }

  if (action === 'channel') {
    state.activeChannelId = target.dataset.channelId;
    state.messages = [];
    state.nextCursor = null;
    state.latestMessageTimestamp = null;
    state.channelState = null;
    state.stateError = '';
    state.reports = [];
    state.reportsError = '';
    state.selectedReportId = '';
    state.expandedTargets = new Set();
    state.highlightedMessageId = '';
    await Promise.all([
      loadMessages({ reset: true }),
      loadChannelState(),
      loadReports()
    ]);
  }

  if (action === 'layer') {
    state.activeLayer = target.dataset.layer;
    render();
  }

  if (action === 'refresh-all') {
    await refreshAll();
  }

  if (action === 'priority-filter') {
    state.priority = state.priority === 'high' ? '' : 'high';
    state.messages = [];
    state.nextCursor = null;
    state.latestMessageTimestamp = null;
    await loadMessages({ reset: true });
  }

  if (action === 'refresh-state') {
    await loadChannelState();
  }

  if (action === 'refresh-reports') {
    await loadReports();
  }

  if (action === 'delete-state') {
    await deleteCurrentState();
  }

  if (action === 'delete-report') {
    await deleteCurrentReport();
  }

  if (action === 'toggle-report') {
    const reportId = target.dataset.reportId || '';
    state.selectedReportId = state.selectedReportId === reportId ? '' : reportId;
    syncReportExpansion();
    if (state.selectedReportId) {
      const openedReportId = state.selectedReportId;
      await hydrateReportSourceMessages(activeReport());
      refreshReportSourceList(openedReportId);
    }
    return;
  }

  if (action === 'toggle-target') {
    const key = target.dataset.targetKey;
    if (!key) return;
    const card = target.closest('[data-target-card]');
    const expanded = state.expandedTargets.has(key);
    if (expanded) {
      state.expandedTargets.delete(key);
    } else {
      state.expandedTargets.add(key);
    }
    if (card) setTargetExpanded(card, !expanded);
    return;
  }

  if (action === 'source-message') {
    await focusSourceMessage(target.dataset.externalId);
  }

  if (action === 'star') {
    event.stopPropagation();
    const id = target.dataset.externalId;
    state.starred.has(id) ? state.starred.delete(id) : state.starred.add(id);
    persistSets();
    render();
  }

  if (action === 'lightbox') {
    event.stopPropagation();
    state.lightbox = target.dataset.src;
    render();
  }

  if (action === 'close-lightbox') {
    state.lightbox = '';
    render();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.lightbox) {
    state.lightbox = '';
    render();
  }
});

async function boot() {
  try {
    await loadChannels();
    await Promise.all([
      loadMessages({ reset: true }),
      loadChannelState(),
      loadReports()
    ]);
  } catch (error) {
    state.error = error.message;
    render();
  }
}

render();
boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
