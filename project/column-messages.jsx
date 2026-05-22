// ChatLens — column components (L2 Messages, L1 Insights, L0 Report)
// All components attached to window so other Babel scripts can use them.

const { useState, useEffect, useMemo, useRef } = React;

// ─────────────────────── Icons ───────────────────────
const Icon = ({ name, size = 14 }) => {
  const props = {
    width: size, height: size, viewBox: '0 0 16 16',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round',
  };
  const paths = {
    search:   <><circle cx="7" cy="7" r="5"/><path d="m11 11 3 3"/></>,
    star:     <path d="M8 1.5 9.9 5.6l4.6.6-3.3 3.2.8 4.6L8 11.8 4 14l.8-4.6L1.5 6.2l4.6-.6z"/>,
    archive:  <><path d="M2 4h12v3H2zM3 7v7h10V7"/><path d="M6.5 10h3"/></>,
    eye:      <><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></>,
    eyeOff:   <><path d="M2 2l12 12"/><path d="M6.5 6.5a2 2 0 0 0 2.8 2.8M3 8s2-3.5 5-4.7M8 3c4 0 6.5 5 6.5 5a12 12 0 0 1-2 2.5"/></>,
    refresh:  <><path d="M14 8a6 6 0 1 1-2-4.5L14 5"/><path d="M14 2v3h-3"/></>,
    filter:   <path d="M2 3h12l-4.5 6v4l-3 1.5v-5.5z"/>,
    dot:      <circle cx="8" cy="8" r="2" fill="currentColor"/>,
    link:     <><path d="M7 9a3 3 0 0 0 4 0l2-2a3 3 0 0 0-4-4l-1 1"/><path d="M9 7a3 3 0 0 0-4 0L3 9a3 3 0 0 0 4 4l1-1"/></>,
    export:   <><path d="M8 1v9M4 6l4-5 4 5M2 11v3h12v-3"/></>,
  };
  return <svg {...props}>{paths[name]}</svg>;
};

// ─────────────────────── Channel icons ───────────────────────
const ChannelIcon = ({ source }) => {
  const map = {
    twitter: { letter: '𝕏', },
    hn:      { letter: 'Y', },
    discord: { letter: 'D', },
    arxiv:   { letter: 'a', },
    github:  { letter: 'G', },
  };
  return <span className="chan-icon">{(map[source] || {}).letter || '·'}</span>;
};

// ─────────────────────── Top Bar ───────────────────────
function TopBar({ channels, channelId, onChannel, search, onSearch, searchOpen, setSearchOpen }) {
  const inputRef = React.useRef(null);
  React.useEffect(() => {
    if (searchOpen && inputRef.current) inputRef.current.focus();
  }, [searchOpen]);
  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-mark"></span>
        ChatLens <small>v0.4</small>
      </div>
      <div className="channels">
        {channels.map(c => (
          <div key={c.id}
               className={'chan' + (c.id === channelId ? ' active' : '')}
               onClick={() => onChannel(c.id)}>
            <ChannelIcon source={c.source}/>
            <span>#{c.name}</span>
            <span className="chan-count">{c.count}</span>
          </div>
        ))}
      </div>
      <div className="topbar-right">
        <span className="live-dot">LIVE · 17:24:08</span>
        <div className={'search-box' + (searchOpen ? ' expanded' : '')}
             onClick={() => !searchOpen && setSearchOpen(true)}>
          <span className="search-icon"><Icon name="search" size={13}/></span>
          <input
            ref={inputRef}
            placeholder="Search across all messages…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onBlur={() => { if (!search) setSearchOpen(false); }}
          />
          <span className="kbd">⌘K</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────── L2 Messages ───────────────────────
function Message({ msg, referenced, highlighted, starred, archived,
                   onStar, onArchive, onFocusTopic, search }) {
  const cls = ['msg'];
  if (msg.pri === 'low') cls.push('low');
  if (referenced) cls.push('referenced');
  if (highlighted) cls.push('highlight');
  if (starred) cls.push('starred');
  if (archived) cls.push('archived');

  // Highlight search matches in text
  const renderText = () => {
    if (!search) return msg.text;
    const re = new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    const parts = msg.text.split(re);
    return parts.map((p, i) =>
      re.test(p) ? <mark key={i} style={{ background: 'var(--accent-soft)', color: 'var(--accent)', padding: '0 1px', borderRadius: '2px' }}>{p}</mark> : p
    );
  };

  return (
    <div className={cls.join(' ')} data-msg-id={msg.id}>
      <div className={`msg-avatar av-${msg.av}`}>{msg.user.substring(0, 2).toUpperCase()}</div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-user">{msg.user}</span>
          <span className="msg-time">{msg.time}</span>
          {msg.pri === 'high' && <span className="msg-pri">High</span>}
          {msg.pri === 'low' && referenced && <span className="msg-pri low">Low · referenced</span>}
          {msg.refs && msg.refs.length > 0 && (
            <span className="msg-tag" style={{ marginLeft: 'auto' }}
                  onClick={(e) => { e.stopPropagation(); onFocusTopic(msg.refs[0]); }}>
              → {msg.refs[0]}
            </span>
          )}
        </div>
        <div className="msg-text">{renderText()}</div>
        {msg.image && (
          <div className="msg-image" onClick={() => window.__openLightbox(msg.image.src)}>
            <img src={msg.image.src} alt=""/>
            <span className="img-meta">{msg.image.caption}</span>
          </div>
        )}
      </div>
      <div className="msg-actions">
        <button title="Star" className="star" onClick={() => onStar(msg.id)}>
          <Icon name="star" size={13}/>
        </button>
        <button title="Archive" onClick={() => onArchive(msg.id)}>
          <Icon name="archive" size={13}/>
        </button>
      </div>
    </div>
  );
}

function MessagesColumn({ channel, messages, focusedTopic, search,
                          starred, archived, onStar, onArchive,
                          onFocusTopic, showLow, setShowLow,
                          activeTopicMsgIds, isActive }) {
  const listRef = useRef(null);

  // Filter messages
  const visibleMessages = useMemo(() => {
    let list = messages;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(m => m.text.toLowerCase().includes(s) || m.user.toLowerCase().includes(s));
    }
    return list;
  }, [messages, search]);

  // Group by day (we only have "Today" but keep extensible)
  const byDay = useMemo(() => {
    const map = {};
    visibleMessages.forEach(m => {
      if (!map[m.day]) map[m.day] = [];
      map[m.day].push(m);
    });
    return map;
  }, [visibleMessages]);

  // Scroll focused message into view
  useEffect(() => {
    if (focusedTopic && activeTopicMsgIds && activeTopicMsgIds.length > 0 && listRef.current) {
      const firstId = activeTopicMsgIds[0];
      const el = listRef.current.querySelector(`[data-msg-id="${firstId}"]`);
      if (el) {
        // Use parent scroll, NOT scrollIntoView
        const container = listRef.current;
        const top = el.offsetTop - 60;
        container.scrollTo({ top, behavior: 'smooth' });
      }
    }
  }, [focusedTopic, activeTopicMsgIds]);

  // Count hidden low-priority messages (not referenced)
  const hiddenLowCount = useMemo(() => {
    if (showLow) return 0;
    return visibleMessages.filter(m =>
      m.pri === 'low' &&
      !(activeTopicMsgIds && activeTopicMsgIds.includes(m.id))
    ).length;
  }, [visibleMessages, showLow, activeTopicMsgIds]);

  const renderMessageList = (list) => {
    const out = [];
    let inHidden = 0;
    list.forEach((m, i) => {
      const referenced = activeTopicMsgIds && activeTopicMsgIds.includes(m.id);
      // Hide low-priority unless referenced or showLow
      if (m.pri === 'low' && !referenced && !showLow) {
        inHidden++;
        // Flush hidden banner before next visible message
        const next = list[i + 1];
        const flushHere = !next ||
          next.pri !== 'low' ||
          (activeTopicMsgIds && activeTopicMsgIds.includes(next.id));
        if (flushHere && inHidden > 0) {
          out.push(
            <div key={`hidden-${i}`} className="hidden-banner"
                 onClick={() => setShowLow(true)}>
              ⋯ {inHidden} low-priority message{inHidden === 1 ? '' : 's'} hidden — click to show
            </div>
          );
          inHidden = 0;
        }
        return;
      }
      out.push(
        <Message
          key={m.id}
          msg={m}
          referenced={referenced}
          highlighted={referenced && focusedTopic}
          starred={starred.has(m.id)}
          archived={archived.has(m.id)}
          onStar={onStar}
          onArchive={onArchive}
          onFocusTopic={onFocusTopic}
          search={search}
        />
      );
    });
    return out;
  };

  const days = Object.keys(byDay);

  return (
    <div className={'col' + (isActive ? ' active-layer' : '')}>
      <div className="col-head">
        <div className="col-title"><b>L2</b> · Raw messages</div>
        <h2>#{channel.name}</h2>
        <div className="col-sub">{messages.length} messages · last activity 2m ago</div>
      </div>
      <div className="col-toolbar">
        <button className={showLow ? 'on' : ''} onClick={() => setShowLow(!showLow)}>
          <Icon name={showLow ? 'eye' : 'eyeOff'} size={11}/>
          {showLow ? 'Showing low-priority' : 'Hiding low-priority'}
        </button>
        <div className="spacer"/>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
          {starred.size > 0 && <>{starred.size} starred · </>}
          auto-refresh 30s
        </span>
      </div>
      <div className="col-body" ref={listRef}>
        <div className="msg-list">
          {days.map(day => (
            <React.Fragment key={day}>
              <div className="msg-day">— {day} —</div>
              {renderMessageList(byDay[day])}
            </React.Fragment>
          ))}
          {visibleMessages.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              No messages match "{search}".
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

window.TopBar = TopBar;
window.MessagesColumn = MessagesColumn;
window.Icon = Icon;
