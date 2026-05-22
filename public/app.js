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
  search: '',
  priority: '',
  includeLow: false,
  activeLayer: 'L2',
  starred: new Set(JSON.parse(localStorage.getItem('chatview.starred') || '[]')),
  archived: new Set(JSON.parse(localStorage.getItem('chatview.archived') || '[]')),
  selectedMessage: null,
  detailLoading: false,
  lightbox: ''
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

function formatTime(seconds) {
  if (!seconds) return 'unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(seconds * 1000));
}

function formatWindow(start, end) {
  if (!start || !end) return 'unknown window';
  return `${formatTime(start)} - ${formatTime(end)}`;
}

function timeAgo(seconds) {
  if (!seconds) return 'unknown';
  const delta = Math.max(1, Math.floor((Date.now() - seconds * 1000) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function initials(name) {
  const trimmed = String(name || '?').trim();
  if (!trimmed) return '?';
  const parts = [...trimmed.replace(/[@#]/g, '').trim()];
  return parts.slice(0, 2).join('').toUpperCase();
}

function priorityLabel(priority) {
  return priorityMeta[priority]?.label || priority || 'Normal';
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

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, label, href) => {
      const safe = safeHref(href.replace(/&amp;/g, '&'));
      return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${label}</a>` : label;
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
  if (state.loading) return;
  state.loading = true;
  state.error = '';
  render();
  try {
    const data = await api(messageQuery(reset));
    state.messages = reset ? data.messages || [] : [...state.messages, ...(data.messages || [])];
    state.nextCursor = data.next_cursor || null;
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

async function selectMessage(externalId) {
  state.detailLoading = true;
  state.selectedMessage = { external_id: externalId };
  state.activeLayer = window.innerWidth <= 880 ? 'L1' : state.activeLayer;
  render();
  try {
    const data = await api(`/api/messages/${encodeURIComponent(externalId)}`);
    state.selectedMessage = data.message;
  } catch (error) {
    state.selectedMessage = { external_id: externalId, error: error.message };
  } finally {
    state.detailLoading = false;
    render();
  }
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
    if (!state.includeLow && !state.priority && (message.priority === 'low' || message.priority === 'ignore')) return false;
    if (!search) return true;
    return [message.channel, message.username, message.content, message.priority]
      .some((value) => String(value || '').toLowerCase().includes(search));
  });
}

function hiddenLowCount() {
  if (state.includeLow || state.priority) return 0;
  return state.messages.filter((message) => message.priority === 'low' || message.priority === 'ignore').length;
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
    ['', 'Signal'],
    ['all', 'All'],
    ['high', 'High'],
    ['normal', 'Normal'],
    ['low', 'Low'],
    ['ignore', 'Ignore']
  ];
  const selected = state.priority || (state.includeLow ? 'all' : '');
  return values.map(([value, label]) =>
    `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function topbarMarkup() {
  return `
    <header class="topbar">
      <div class="brand" aria-label="ChatLens">
        <span class="brand-mark"></span>
        <span>ChatLens</span>
        <small>L2 live</small>
      </div>
      <nav class="channels" aria-label="Channels">${channelMarkup()}</nav>
      <div class="topbar-right">
        <span class="live-dot">API LIVE</span>
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
  const isSelected = state.selectedMessage?.external_id === message.external_id;
  const classes = [
    'message',
    `priority-${message.priority}`,
    isStarred ? 'starred' : '',
    isArchived ? 'archived' : '',
    isSelected ? 'selected' : ''
  ].filter(Boolean).join(' ');

  return `
    <article class="${classes}" data-action="detail" data-external-id="${escapeHtml(message.external_id)}">
      <div class="message-main">
        <div class="message-head">
          <strong>${escapeHtml(message.username)}</strong>
          <time title="${escapeHtml(new Date(message.timestamp * 1000).toISOString())}">${escapeHtml(formatTime(message.timestamp))}</time>
          <span class="priority-badge ${message.priority}">${escapeHtml(priorityLabel(message.priority))}</span>
        </div>
        ${message.content ? `<p class="message-text">${escapeHtml(message.content)}</p>` : '<p class="message-text muted">No text content</p>'}
        ${message.image_url ? `
          <button class="thumb" data-action="lightbox" data-src="${escapeHtml(message.image_url)}">
            <img src="${escapeHtml(message.image_url)}" alt="">
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

function l2Markup() {
  const channel = activeChannel();
  const visible = visibleMessages();
  const hidden = hiddenLowCount();

  return `
    <section class="column l2 ${state.activeLayer === 'L2' ? 'active-layer' : ''}">
      <div class="column-head">
        <div class="column-title"><b>L2</b> Raw messages</div>
        <h1>${escapeHtml(channel?.channel || 'No channel')}</h1>
        <p>${channel?.message_count || 0} total messages · ${state.messages.length} loaded</p>
      </div>
      <div class="toolbar">
        <select class="select" data-action="priority">${priorityOptions()}</select>
        <button class="${state.includeLow ? 'on' : ''}" data-action="toggle-low">${state.includeLow ? 'Showing low/ignore' : 'Hiding low/ignore'}</button>
        <span class="toolbar-note">${visible.length} visible</span>
      </div>
      <div class="column-body">
        ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
        ${hidden ? `<button class="hidden-banner" data-action="toggle-low">${hidden} low/ignore messages hidden - click to show</button>` : ''}
        <div class="message-list">
          ${visible.map(messageMarkup).join('')}
        </div>
        ${state.loading ? '<div class="status">Loading...</div>' : ''}
        ${!state.loading && visible.length === 0 ? '<div class="empty">No messages match this view.</div>' : ''}
        ${state.nextCursor ? '<button class="load-more" data-action="load-more">Load more</button>' : ''}
      </div>
    </section>
  `;
}

function detailMarkup() {
  const message = state.selectedMessage;
  if (!message) {
    return `
      <div class="empty-panel">
        <span class="panel-kicker">L2 detail</span>
        <h2>Select a message</h2>
        <p>Click any row in the raw feed to load its canonical record from <code>GET /api/messages/{external_id}</code>.</p>
      </div>
    `;
  }
  if (state.detailLoading) return '<div class="status">Loading message detail...</div>';
  if (message.error) return `<div class="error">${escapeHtml(message.error)}</div>`;
  return `
    <div class="detail-card">
      <span class="panel-kicker">Message detail</span>
      <h2>${escapeHtml(message.username)}</h2>
      <dl>
        <dt>external_id</dt><dd><code>${escapeHtml(message.external_id)}</code></dd>
        <dt>channel</dt><dd>${escapeHtml(message.channel)}</dd>
        <dt>channel_id</dt><dd><code>${escapeHtml(message.channel_id)}</code></dd>
        <dt>timestamp</dt><dd>${escapeHtml(formatTime(message.timestamp))} · ${escapeHtml(String(message.timestamp))}</dd>
        <dt>priority</dt><dd><span class="priority-badge ${message.priority}">${escapeHtml(priorityLabel(message.priority))}</span></dd>
      </dl>
      <div class="detail-content">${message.content ? escapeHtml(message.content) : '<span class="muted">No text content</span>'}</div>
      ${message.image_url ? `<img class="detail-image" src="${escapeHtml(message.image_url)}" alt="">` : ''}
    </div>
  `;
}

function l1Markup() {
  const channel = activeChannel();
  const snapshot = state.channelState;
  const cards = snapshot?.cards || [];
  const sourceCount = snapshot?.source_message_ids?.length || 0;

  return `
    <section class="column l1 ${state.activeLayer === 'L1' ? 'active-layer' : ''}">
      <div class="column-head">
        <div class="column-title"><b>L1</b> Aggregated insights</div>
        <h1>${snapshot ? 'Channel state' : 'No L1 state'}</h1>
        <p>${escapeHtml(channel?.channel || 'selected channel')}${snapshot ? ` · ${escapeHtml(formatWindow(snapshot.window_start, snapshot.window_end))}` : ''}</p>
      </div>
      <div class="toolbar">
        <button data-action="refresh-state">Refresh</button>
        <span class="toolbar-note">${snapshot ? `${cards.length} cards · ${sourceCount} sources` : 'waiting for API state'}</span>
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
            <span class="panel-kicker">L1 · ${escapeHtml(snapshot.state_id)}</span>
            <div class="state-meta">
              <span>${escapeHtml(formatWindow(snapshot.window_start, snapshot.window_end))}</span>
              <span>${sourceCount} source messages</span>
              ${snapshot.previous_state_id ? `<span>prev ${escapeHtml(snapshot.previous_state_id)}</span>` : ''}
            </div>
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
                  ${(card.message_ids || []).length ? `<div class="source-row">${card.message_ids.map((id) => `<code>${escapeHtml(id)}</code>`).join('')}</div>` : ''}
                </article>
              `).join('')}
            </div>
          ` : '<div class="empty inline-empty">No cards in this state.</div>'}
        ` : ''}
        ${detailMarkup()}
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
        <button data-action="refresh-reports">Refresh</button>
        <span class="toolbar-note">${selected ? escapeHtml(formatWindow(selected.window_start, selected.window_end)) : 'latest first'}</span>
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
                <span class="report-window">${escapeHtml(formatWindow(report.window_start, report.window_end))}</span>
                <strong>${escapeHtml(report.title || 'Untitled report')}</strong>
                <span>${escapeHtml(report.summary || 'No summary')}</span>
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
  state.priority = value === 'all' ? '' : value;
  state.includeLow = value === 'all' || value === 'low' || value === 'ignore';
  state.messages = [];
  state.nextCursor = null;
  await loadMessages({ reset: true });
});

app.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  if (action === 'channel') {
    state.activeChannelId = target.dataset.channelId;
    state.messages = [];
    state.nextCursor = null;
    state.channelState = null;
    state.stateError = '';
    state.reports = [];
    state.reportsError = '';
    state.selectedReportId = '';
    state.selectedMessage = null;
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

  if (action === 'toggle-low') {
    state.includeLow = !state.includeLow;
    render();
  }

  if (action === 'load-more') {
    await loadMessages();
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

  if (action === 'detail') {
    await selectMessage(target.dataset.externalId);
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
