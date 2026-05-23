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
  search: '',
  priority: '',
  activeLayer: 'L2',
  starred: new Set(JSON.parse(localStorage.getItem('chatview.starred') || '[]')),
  archived: new Set(JSON.parse(localStorage.getItem('chatview.archived') || '[]')),
  sourceMessages: new Map(),
  highlightedMessageId: '',
  lightbox: '',
  forceL2ScrollTop: null
};

const priorityMeta = {
  high: { label: 'High', rank: 3 },
  normal: { label: 'Normal', rank: 2 },
  low: { label: 'Low', rank: 1 },
  ignore: { label: 'Ignore', rank: 0 }
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

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
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
  localStorage.setItem('chatview.archived', JSON.stringify([...state.archived]));
}

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
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
    const params = new URLSearchParams({ channel_id: state.activeChannelId, level: 'L1' });
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
    const params = new URLSearchParams({ level: 'L0', limit: '20' });
    if (state.activeChannelId) params.set('channel_id', state.activeChannelId);
    const data = await api(`/api/reports?${params.toString()}`);
    state.reports = data.reports || [];
    if (!state.reports.some((report) => report.report_id === state.selectedReportId)) {
      state.selectedReportId = state.reports[0]?.report_id || '';
    }
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
  state.search = '';
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
  return state.reports.find((report) => report.report_id === state.selectedReportId) || state.reports[0] || null;
}

function visibleMessages() {
  const search = state.search.trim().toLowerCase();
  return state.messages.filter((message) => {
    if (!search) return true;
    return [message.channel, message.username, message.content, message.priority]
      .some((value) => String(value || '').toLowerCase().includes(search));
  });
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

function priorityOptions() {
  const values = [
    ['', 'All priority'],
    ['high', 'High'],
    ['normal', 'Normal'],
    ['low', 'Low'],
    ['ignore', 'Ignore']
  ];
  const selected = state.priority;
  return values.map(([value, label]) =>
    `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`
  ).join('');
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
    <header class="topbar">
      <div class="brand" aria-label="ChatView">
        <span class="brand-mark"></span>
        <span>ChatView</span>
        <small>L2 live</small>
      </div>
      <nav class="channels" aria-label="Channels">${channelMarkup()}</nav>
      <div class="topbar-right">
        <span class="sync-stamp" title="${escapeHtml(lastUpdatedText())}">${escapeHtml(lastUpdatedText())}</span>
        <button class="header-button" data-action="refresh-all" ${state.loading || state.stateLoading || state.reportsLoading ? 'disabled' : ''}>Refresh</button>
        <select class="header-select" data-action="priority">${priorityOptions()}</select>
        <label class="search-box">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5"></circle><path d="m11 11 3 3"></path></svg>
          <input type="search" value="${escapeHtml(state.search)}" placeholder="Search loaded messages" data-action="search">
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
  const isArchived = state.archived.has(message.external_id);
  const contentImageUrls = new Set(markdownImageUrls(message.content));
  const imageHref = safeHref(message.image_url);
  const showStandaloneImage = imageHref && !contentImageUrls.has(imageHref);
  const classes = [
    'message',
    `priority-${message.priority}`,
    isStarred ? 'starred' : '',
    isArchived ? 'archived' : '',
    state.highlightedMessageId === message.external_id ? 'highlighted' : ''
  ].filter(Boolean).join(' ');

  return `
    <article class="${classes}" data-message-id="${escapeHtml(message.external_id)}">
      <div class="message-main">
        <div class="message-head">
          <strong>${escapeHtml(message.username)}</strong>
          <span class="priority-badge ${message.priority}">${escapeHtml(priorityLabel(message.priority))}</span>
        </div>
        ${message.content ? `<div class="message-text message-markdown">${markdownMarkup(message.content)}</div>` : '<p class="message-text muted">No text content</p>'}
        ${showStandaloneImage ? `
          <button class="thumb" data-action="lightbox" data-src="${escapeHtml(imageHref)}">
            <img src="${escapeHtml(imageHref)}" alt="">
            <span>image_url</span>
          </button>
        ` : ''}
      </div>
      <div class="message-actions">
        <button title="Star" data-action="star" data-external-id="${escapeHtml(message.external_id)}">${isStarred ? '★' : '☆'}</button>
        <button title="Archive" data-action="archive" data-external-id="${escapeHtml(message.external_id)}">${isArchived ? '↩' : '⌫'}</button>
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

  return `
    <section class="column l1 ${state.activeLayer === 'L1' ? 'active-layer' : ''}">
      <div class="column-head">
        <div class="column-title"><b>L1</b> Aggregated insights</div>
        <h1>${snapshot ? 'Channel state' : 'No L1 state'}</h1>
        <p>${escapeHtml(channel?.channel || 'selected channel')}</p>
      </div>
      <div class="toolbar">
        <span class="toolbar-note">${snapshot ? `${cards.length} cards` : 'waiting for API state'}</span>
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

function l0Markup() {
  const channel = activeChannel();
  const selected = activeReport();
  return `
    <section class="column l0 ${state.activeLayer === 'L0' ? 'active-layer' : ''}">
      <div class="column-head">
        <div class="column-title"><b>L0</b> Deep research</div>
        <h1>Research reports</h1>
        <p>${escapeHtml(channel?.channel || 'selected channel')} · ${state.reports.length} loaded</p>
      </div>
      <div class="toolbar">
        <span class="toolbar-note">${state.reports.length} reports</span>
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
          <div class="report-list">
            ${state.reports.map((report) => `
              <button class="report-item ${selected?.report_id === report.report_id ? 'active' : ''}"
                data-action="select-report" data-report-id="${escapeHtml(report.report_id)}">
                <strong>${escapeHtml(report.title || 'Untitled report')}</strong>
              </button>
            `).join('')}
          </div>
        ` : ''}
        ${selected ? `
          <article class="report-shell">
            <div class="report-eyebrow">Deep research · L0 · ${escapeHtml(selected.report_id)}</div>
            <h2>${escapeHtml(selected.title || 'Untitled report')}</h2>
            ${selected.summary ? `<p class="exec">${escapeHtml(selected.summary)}</p>` : ''}
            ${(selected.topics || []).length ? `<div class="topic-tags">${selected.topics.map((topic) => `<span>${escapeHtml(topic)}</span>`).join('')}</div>` : ''}
            <div class="markdown-body">${markdownMarkup(selected.markdown)}</div>
            ${(selected.references || []).length ? `
              <h3>References</h3>
              <div class="reference-list">
                ${selected.references.map((reference) => {
                  const href = safeHref(reference.url);
                  const label = reference.title || reference.url || 'Reference';
                  return href
                    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
                    : `<span>${escapeHtml(label)}</span>`;
                }).join('')}
              </div>
            ` : ''}
            <div class="report-sources">
              <span>${(selected.source_state_ids || []).length} state sources</span>
              <span>${(selected.source_message_ids || []).length} message sources</span>
            </div>
          </article>
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

app.addEventListener('input', (event) => {
  const action = event.target?.dataset?.action;
  if (action === 'search') {
    state.search = event.target.value;
    render();
  }
});

app.addEventListener('change', async (event) => {
  if (event.target?.dataset?.action !== 'priority') return;
  const value = event.target.value;
  state.priority = value;
  state.messages = [];
  state.nextCursor = null;
  state.latestMessageTimestamp = null;
  await loadMessages({ reset: true });
});

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

  if (action === 'refresh-state') {
    await loadChannelState();
  }

  if (action === 'refresh-reports') {
    await loadReports();
  }

  if (action === 'select-report') {
    state.selectedReportId = target.dataset.reportId;
    render();
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

  if (action === 'archive') {
    event.stopPropagation();
    const id = target.dataset.externalId;
    state.archived.has(id) ? state.archived.delete(id) : state.archived.add(id);
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
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector('[data-action="search"]')?.focus();
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
