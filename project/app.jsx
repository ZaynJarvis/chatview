// ChatLens — main app

const { useState: useStateApp, useEffect: useEffectApp, useMemo: useMemoApp } = React;

// Layer tabs — visible only on narrow viewports via CSS
function LayerTabs({ activeLayer, setActiveLayer, channel, messages, topics }) {
  const tabs = [
    { id: 'L2', eyebrow: 'L2', label: 'Messages', count: messages.length },
    { id: 'L1', eyebrow: 'L1', label: 'Insights', count: topics.length },
    { id: 'L0', eyebrow: 'L0', label: 'Report',   count: null },
  ];
  return (
    <div className="layer-tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id}
                className={'layer-tab' + (activeLayer === t.id ? ' active' : '')}
                onClick={() => setActiveLayer(t.id)}
                role="tab" aria-selected={activeLayer === t.id}>
          <span className="lt-eyebrow">{t.eyebrow}</span>
          <span className="lt-label">{t.label}</span>
          {t.count !== null && <span className="lt-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

function App() {
  // Tweaks
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);

  // App state
  const channels = window.DATA.channels;
  const [channelId, setChannelId] = useStateApp(channels[0].id);
  const [search, setSearch] = useStateApp('');
  const [focusedTopic, setFocusedTopic] = useStateApp(null);
  const [showLow, setShowLow] = useStateApp(false);
  const [starred, setStarred] = useStateApp(new Set(['m108', 'h201']));
  const [archived, setArchived] = useStateApp(new Set());
  const [lightbox, setLightbox] = useStateApp(null);
  const [activeLayer, setActiveLayer] = useStateApp('L2'); // L2 | L1 | L0 — only used on narrow viewports
  const [searchOpen, setSearchOpen] = useStateApp(false);

  // Lightbox handler exposed globally for message clicks
  useEffectApp(() => {
    window.__openLightbox = (src) => setLightbox(src);
    return () => { window.__openLightbox = null; };
  }, []);

  // Apply theme + column widths
  useEffectApp(() => {
    document.body.setAttribute('data-theme', t.theme || 'slate');
    const ratios = t.columnRatios || [1, 1, 1];
    const sum = ratios[0] + ratios[1] + ratios[2];
    document.documentElement.style.setProperty('--c-l2', `${ratios[0]}fr`);
    document.documentElement.style.setProperty('--c-l1', `${ratios[1]}fr`);
    document.documentElement.style.setProperty('--c-l0', `${ratios[2]}fr`);
  }, [t.theme, t.columnRatios]);

  // Reset focused topic when channel changes
  useEffectApp(() => {
    setFocusedTopic(null);
  }, [channelId]);

  // Get current channel + data
  const channel = useMemoApp(() => channels.find(c => c.id === channelId) || channels[0], [channelId]);
  const messages = window.DATA.messages[channelId] || [];
  const topics = window.DATA.topics[channelId] || [];
  const report = window.DATA.reports[channelId];

  // Compute referenced messages when a topic is focused
  const activeTopicMsgIds = useMemoApp(() => {
    if (!focusedTopic) return [];
    const topic = topics.find(t => t.id === focusedTopic);
    return topic ? (topic.msgs || []) : [];
  }, [focusedTopic, topics]);

  const onStar = (id) => {
    setStarred(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const onArchive = (id) => {
    setArchived(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Keyboard shortcut: Cmd+K focus search
  useEffectApp(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const inp = document.querySelector('.search-box input');
        if (inp) inp.focus();
      }
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Cross-layer focus: when focusedTopic is set from L0 or L1 on mobile, auto-jump.
  // We track previous focusedTopic to detect a fresh focus event.
  const prevFocusRef = React.useRef(focusedTopic);
  useEffectApp(() => {
    if (focusedTopic && focusedTopic !== prevFocusRef.current) {
      // Only auto-jump on narrow viewports
      if (window.innerWidth <= 840) {
        // Coming from L0 (cite click) → jump to L1. From L1 → jump to L2.
        if (activeLayer === 'L0') setActiveLayer('L1');
        else if (activeLayer === 'L1') setActiveLayer('L2');
      }
    }
    prevFocusRef.current = focusedTopic;
  }, [focusedTopic]);

  return (
    <>
      <TopBar channels={channels} channelId={channelId} onChannel={setChannelId}
              search={search} onSearch={setSearch}
              searchOpen={searchOpen} setSearchOpen={setSearchOpen}/>
      <LayerTabs activeLayer={activeLayer} setActiveLayer={setActiveLayer}
                 channel={channel} messages={messages} topics={topics}/>
      <div className="columns">
        <MessagesColumn
          channel={channel}
          messages={messages}
          focusedTopic={focusedTopic}
          search={search}
          starred={starred}
          archived={archived}
          onStar={onStar}
          onArchive={onArchive}
          onFocusTopic={setFocusedTopic}
          showLow={showLow}
          setShowLow={setShowLow}
          activeTopicMsgIds={activeTopicMsgIds}
          isActive={activeLayer === 'L2'}
        />
        <InsightsColumn
          channel={channel}
          topics={topics}
          focusedTopic={focusedTopic}
          onFocusTopic={setFocusedTopic}
          isActive={activeLayer === 'L1'}
        />
        <ReportColumn
          channel={channel}
          report={report}
          focusedTopic={focusedTopic}
          onFocusTopic={setFocusedTopic}
          isActive={activeLayer === 'L0'}
        />
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt=""/>
        </div>
      )}

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme"/>
        <TweakRadio
          label="Aesthetic"
          value={t.theme}
          options={['slate', 'paper', 'mono']}
          onChange={(v) => setTweak('theme', v)}
        />
        <TweakSection label="Column widths"/>
        <TweakRadio
          label="Preset"
          value={t.widthPreset}
          options={['equal', 'L2-heavy', 'L0-heavy']}
          onChange={(v) => {
            const map = {
              'equal':    [1, 1, 1],
              'L2-heavy': [1.6, 1, 1],
              'L0-heavy': [1, 1, 1.6],
            };
            setTweak({ widthPreset: v, columnRatios: map[v] });
          }}
        />
        <TweakSection label="Reading"/>
        <TweakToggle
          label="Show low-priority messages"
          value={showLow}
          onChange={setShowLow}
        />
      </TweaksPanel>
    </>
  );
}

window.App = App;
