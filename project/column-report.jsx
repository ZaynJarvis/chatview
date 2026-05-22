// ChatLens — L0 Deep research report column

function ReportColumn({ channel, report, focusedTopic, onFocusTopic, isActive }) {
  if (!report) {
    return (
      <div className={'col' + (isActive ? ' active-layer' : '')}>
        <div className="col-head">
          <div className="col-title"><b>L0</b> · Deep research</div>
          <h2>No report yet</h2>
        </div>
      </div>
    );
  }

  // Render citation chip — clicking it focuses the topic in L1 (which also reveals msgs in L2)
  const Cite = ({ id }) => (
    <span className={'cite' + (focusedTopic === id ? ' active' : '')}
          onClick={() => onFocusTopic(focusedTopic === id ? null : id)}>
      {id}
    </span>
  );

  return (
    <div className={'col' + (isActive ? ' active-layer' : '')}>
      <div className="col-head">
        <div className="col-title"><b>L0</b> · Deep research</div>
        <h2>Deep research</h2>
        <div className="col-sub">Auto-generated · click citations to trace sources</div>
      </div>
      <div className="col-toolbar">
        <button><Icon name="refresh" size={11}/> Regenerate</button>
        <button><Icon name="export" size={11}/> Export</button>
        <div className="spacer"/>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
          confidence: <b style={{ color: 'var(--text-mute)' }}>{report.confidence}</b> · coverage {report.coverage}
        </span>
      </div>
      <div className="col-body">
        <div className="report">
          <div className="report-header">
            <div className="report-eyebrow">{report.eyebrow}</div>
            <h1 className="report-title">{report.title}</h1>
            <div className="report-byline">
              <span>Generated <b>{report.generated.split('·')[0].trim()}</b></span>
              <span>Channel <b>#{channel.name}</b></span>
              <span>Model <b>claude-haiku-4.5</b></span>
            </div>
          </div>

          <h3>Executive summary</h3>
          <div className="exec">{report.exec}</div>

          <h3>Structured findings</h3>
          {report.findings.map(f => (
            <div key={f.num} className="finding">
              <div className="finding-num">{f.num}</div>
              <div>
                <div className="finding-title">
                  {f.title}
                  {' '}
                  {f.cites.map(c => <Cite key={c} id={c}/>)}
                </div>
                <div className="finding-body">{f.body}</div>
              </div>
            </div>
          ))}

          <h3>Recommendations</h3>
          <div className="recs">
            <div className="recs-head">Actions worth taking · ordered by signal strength</div>
            {report.recs.map((r, i) => (
              <div key={i} className="rec-item">
                <span className="badge">{r.badge}</span>
                <span>{r.text}</span>
              </div>
            ))}
          </div>

          <div className="report-foot">
            <span>↳ {report.generated}</span>
            <span>cite: hover any [tN] to trace sources</span>
          </div>
        </div>
      </div>
    </div>
  );
}

window.ReportColumn = ReportColumn;
