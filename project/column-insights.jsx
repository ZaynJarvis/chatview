// ChatLens — L1 Insights column with topic-kind-specific renders

const { useMemo: useMemoL1 } = React;

// Sparkline
function Sparkline({ data, width = 120, height = 32, color = 'var(--accent)' }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const area = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
  const line = `M${pts.join(' L')}`;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={area} fill={color} opacity="0.14"/>
      <path d={line} stroke={color} strokeWidth="1.5" fill="none"/>
      <circle cx={width} cy={height - ((data[data.length-1] - min) / range) * (height - 4) - 2}
              r="2.5" fill={color}/>
    </svg>
  );
}

// ─────────────────────── Topic renders ───────────────────────
function TopicDiscussion({ topic }) {
  const sent = topic.sentiment || { pos: 33, neu: 34, neg: 33 };
  const total = sent.pos + sent.neu + sent.neg;
  return (
    <div className="t-discussion">
      <div className="topic-summary">{topic.summary}</div>
      <div className="voices" style={{ marginTop: 10, display: 'flex', alignItems: 'center' }}>
        <div className="voice-stack">
          {(topic.voices || []).slice(0, 5).map((v, i) => (
            <span key={i} className={`v av-${(i % 7) + 1}`}>{v}</span>
          ))}
          {topic.voices && topic.voices.length > 5 && (
            <span className="v" style={{ background: 'var(--border)', color: 'var(--text-mute)' }}>
              {topic.voices[topic.voices.length-1]}
            </span>
          )}
        </div>
        <div className="sentiment">
          <span className="sent-bar">
            <span className="pos" style={{ width: `${(sent.pos/total)*100}%` }}/>
            <span className="neu" style={{ width: `${(sent.neu/total)*100}%` }}/>
            <span className="neg" style={{ width: `${(sent.neg/total)*100}%` }}/>
          </span>
        </div>
      </div>
    </div>
  );
}

function TopicMetric({ topic }) {
  return (
    <div className="t-metric">
      <div className="metric-row">
        <div>
          <div className="metric-value">
            {topic.value}
            <span className={`metric-delta ${topic.deltaDir === 'down' ? 'neg' : ''}`}>
              {topic.deltaDir === 'up' ? '↑' : '↓'} {topic.delta}
            </span>
          </div>
          <div className="metric-label">{topic.label}</div>
        </div>
        <Sparkline data={topic.spark} width={140} height={40}/>
      </div>
      <div className="topic-summary" style={{ marginTop: 10 }}>{topic.summary}</div>
    </div>
  );
}

function TopicRelease({ topic }) {
  return (
    <div className="t-release">
      <div className="topic-summary">{topic.summary}</div>
      <div className="release-meta">
        {topic.tag && <span className="release-tag">{topic.tag}</span>}
        <span>{topic.meta}</span>
      </div>
    </div>
  );
}

function TopicEvent({ topic }) {
  return (
    <div className="t-event">
      <div className="topic-summary">{topic.summary}</div>
      {topic.steps && (
        <div className="event-timeline">
          {topic.steps.map((s, i) => (
            <div key={i} className="event-step">
              <time>{s.time}</time>
              {s.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TopicQuestion({ topic }) {
  return (
    <div className="t-question">
      <div className="topic-summary">{topic.summary}</div>
      <div className="q-mark">unresolved · multiple voices · no consensus yet</div>
    </div>
  );
}

const TOPIC_RENDERERS = {
  discussion: TopicDiscussion,
  metric:     TopicMetric,
  release:    TopicRelease,
  event:      TopicEvent,
  question:   TopicQuestion,
};

// ─────────────────────── Topic card ───────────────────────
function TopicCard({ topic, active, onClick }) {
  const Renderer = TOPIC_RENDERERS[topic.kind] || TopicDiscussion;
  return (
    <div className={'topic t-' + topic.kind + (active ? ' active' : '')}
         data-topic-id={topic.id}
         onClick={onClick}>
      <div className="topic-head">
        <span className={`topic-kind ${topic.kind}`}>{topic.kind}</span>
        {topic.heat && (
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
            heat {topic.heat}
          </span>
        )}
        <span className="topic-ref">{topic.id}</span>
      </div>
      <div className="topic-title">{topic.title}</div>
      <Renderer topic={topic}/>
      <div className="topic-foot">
        {(topic.sources || []).slice(0, 3).map(s => (
          <span key={s} className="src">#{s}</span>
        ))}
        <span className="show-msgs">
          {topic.msgs && topic.msgs.length} msgs →
        </span>
      </div>
    </div>
  );
}

function InsightsColumn({ channel, topics, focusedTopic, onFocusTopic, isActive }) {
  return (
    <div className={'col' + (isActive ? ' active-layer' : '')}>
      <div className="col-head">
        <div className="col-title"><b>L1</b> · Aggregated insights</div>
        <h2>{topics.length} topics · refreshed 2m ago</h2>
        <div className="col-sub">Clustered from #{channel.name} · auto-grouped by signal type</div>
      </div>
      <div className="col-toolbar">
        <button><Icon name="filter" size={11}/> All kinds</button>
        <button><Icon name="refresh" size={11}/> Re-cluster</button>
        <div className="spacer"/>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
          sort: heat ↓
        </span>
      </div>
      <div className="col-body">
        <div className="insights">
          {topics.map(t => (
            <TopicCard key={t.id} topic={t}
                       active={focusedTopic === t.id}
                       onClick={() => onFocusTopic(t.id === focusedTopic ? null : t.id)}/>
          ))}
        </div>
      </div>
    </div>
  );
}

window.InsightsColumn = InsightsColumn;
window.Sparkline = Sparkline;
