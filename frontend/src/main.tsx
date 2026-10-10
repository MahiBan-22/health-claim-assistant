import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClaimCase, Document, Run, Report, Ref } from './types';
import './style.css';

type Connection = { connected: boolean; storage_available: boolean; email?: string | null; message?: string; model?: string; model_available?: boolean };
const base = 'http://127.0.0.1:8000';
function App() {
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [cases, setCases] = useState<ClaimCase[]>([]);
  const [selected, setSelected] = useState<ClaimCase | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [view, setView] = useState('workspace');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ ref: Ref; text: string } | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [chatgpt, setChatgpt] = useState<Connection | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const signInStarted = useRef(0);
  const signInWindow = useRef<Window | null>(null);

  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(base + path, { ...options, headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) } });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(typeof result.detail === 'string' ? result.detail : 'Request failed (' + response.status + ')');
    }
    return response.json() as Promise<T>;
  }
  async function act(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Unexpected error'); }
    finally { setBusy(false); }
  }
  const [liveStatus, setLiveStatus] = useState('');
  useEffect(() => {
    if (!connected || !selected) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    async function listen() {
      try {
        setLiveStatus('Connecting to live analysis updates…');
        const response = await fetch(base + '/cases/' + selected!.id + '/analysis-events', {
          headers: {Authorization: 'Bearer ' + token}, signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('Live updates unavailable');
        setLiveStatus('Live analysis updates connected');
        delay = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const {value, done} = await reader.read();
            if (done) throw new Error('Live connection ended');
            buffer += decoder.decode(value, {stream: true});
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (!event.startsWith('data: ')) continue;
              const current = JSON.parse(event.slice(6)) as Run[];
              if (controller.signal.aborted) return;
              setRuns(current);
              setRun(previous => previous ? current.find(item => item.id === previous.id) || null : null);
            }
          }
        } finally { reader.releaseLock(); }
      } catch {
        if (controller.signal.aborted) return;
        setLiveStatus('Live connection interrupted. Reconnecting…');
        retry = setTimeout(() => void listen(), delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
    void listen();
    return () => {controller.abort(); if (retry) clearTimeout(retry);};
  }, [connected, selected?.id, token]);

  async function refreshConnection() {
    const status = await api<Connection>('/auth/chatgpt/status');
    if (status.connected) {
      try {
        const catalog = await api<{selected_model_available: boolean}>('/auth/chatgpt/models');
        status.model_available = catalog.selected_model_available;
        status.message = catalog.selected_model_available ? 'ChatGPT connected. Luna is available for analysis.' : 'Your connected account does not currently list gpt-6-luna. Analysis is paused; no other model will be used.';
      } catch (e) {
        status.model_available = false;
        status.message = e instanceof Error ? e.message : 'Model catalog unavailable';
      }
    }
    setChatgpt(status);
    return status;
  }
  useEffect(() => {
    if (!connected) { setChatgpt(null); setSigningIn(false); return; }
    let cancelled = false;
    void api<Connection>('/auth/chatgpt/status').then(status => {
      if (!cancelled) { setChatgpt(status); if (status.connected) void refreshConnection().catch(e => setError(String(e))); }
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [connected, token]);
  useEffect(() => {
    if (!signingIn || !connected) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (Date.now() - signInStarted.current > 600000 || signInWindow.current?.closed) {
        setSigningIn(false);
        void refreshConnection().catch(e => setError(String(e)));
        return;
      }
      void api<Connection>('/auth/chatgpt/status').then(async status => {
        if (cancelled) return;
        if (status.connected) { setSigningIn(false); await refreshConnection(); }
      }).catch(e => { if (!cancelled) {setError(String(e)); setSigningIn(false);} });
    }, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [signingIn, connected, token]);
  function connectChatGPT() {
    const popup = window.open('', 'claim-chatgpt-signin', 'width=650,height=780');
    if (!popup) { setError('Allow the sign-in popup, then click Continue with ChatGPT again.'); return; }
    signInWindow.current = popup;
    void act(async () => {
      try {
        const response = await api<{sign_in_url: string}>('/auth/chatgpt/start', {method: 'POST'});
        popup.location.href = response.sign_in_url;
        signInStarted.current = Date.now();
        setSigningIn(true);
      } catch (e) { popup.close(); throw e; }
    });
  }

  async function choose(item: ClaimCase) {
    setSelected(item); setRun(null); setRuns([]); setReport(null); setPreview(null);
    setRuns(await api<Run[]>('/cases/' + item.id + '/analyses'));
    setDocuments(await api<Document[]>('/cases/' + item.id + '/documents'));
  }
  async function openReport(item: Run) {
    if (!item.report_id) return;
    setReport(await api<Report>('/reports/' + item.report_id));
    setPreview(null); setView('report');
  }
  async function saveRun(item: Run) {
    setRun(item);
    setRuns(previous => [item, ...previous.filter(r => r.id !== item.id)].sort((a,b) => b.created_at.localeCompare(a.created_at)));
  }
  async function removeRun(item: Run) {
    if (!window.confirm('Delete this analysis, its report and review history? Uploaded documents will remain.')) return;
    await api('/analyses/' + item.id, {method: 'DELETE'});
    setRuns(previous => previous.filter(r => r.id !== item.id));
    if (run?.id === item.id) setRun(null);
    if (report?.run_id === item.id) {setReport(null); setPreview(null);}
    setNotice('Analysis deleted. Uploaded documents were kept.');
  }
  async function inspect(ref: Ref) {
    if (!report) return;
    const page = await api<{text: string}>('/cases/' + report.case_id + '/documents/' + ref.document_id + '/pages/' + ref.page);
    setPreview({ref, text: page.text});
  }
  async function original(ref: Ref) {
    if (!report) return;
    const response = await fetch(base + '/cases/' + report.case_id + '/documents/' + ref.document_id + '/original', {headers: {Authorization: 'Bearer ' + token}});
    if (!response.ok) throw new Error('Original document unavailable');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = 'source-' + ref.document_id; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'claim-package-v' + report.version + '.json'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="app">
    <aside><div className="brand">CE<span>Claim Evidence</span></div><p className="muted">Your documents. Clear next steps.</p>
      <nav>{[['workspace','Claim workspace'],['report','Evidence report'],['review','Reviewer workspace']].map(([id,label]) => <button className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)}>{label}</button>)}</nav>
      <div className="sidebar-note">Reports explain available evidence. Insurer acceptance and payment remain external decisions.</div>
    </aside>
    <main><header><div><span className="eyebrow">HEALTH CLAIM EVIDENCE ASSISTANT</span><h1>{view === 'workspace' ? 'Claim workspace' : view === 'report' ? 'Evidence report' : 'Reviewer workspace'}</h1></div><span className="badge">Local workspace</span></header>
      {error && <div role="alert" className="alert">{error}</div>}{notice && <div role="status" className="notice">{notice}</div>}
      {!connected ? <section className="card"><h2>Open your local workspace</h2><p>Enter the local access token configured for this installation.</p><form onSubmit={e => {e.preventDefault(); void act(async () => {setCases(await api<ClaimCase[]>('/cases')); setConnected(true);});}}><label>Access token<input type="password" required value={token} onChange={e => setToken(e.target.value)} autoComplete="off" /></label><button disabled={busy}>Open workspace</button></form></section> : <>
        <div className="case-bar"><label>Current case<select value={selected?.id || ''} onChange={e => {const item = cases.find(c => c.id === e.target.value); if (item) void act(() => choose(item));}}><option value="">Select a case</option>{cases.map(c => <option key={c.id} value={c.id}>{c.title} · {c.claim_reference}</option>)}</select></label><button className="secondary" onClick={() => {setConnected(false); setToken(''); setSelected(null); setReport(null); setRun(null); setRuns([]); setDocuments([]); setPreview(null);}}>Lock workspace</button></div>
        <section className="card"><div className="section-heading"><div><h2>ChatGPT connection</h2><p>{chatgpt?.message || 'Checking the host connection…'}{chatgpt?.email && <><br/>Account: {chatgpt.email}</>}</p></div><div className="citations"><button disabled={busy || signingIn} onClick={connectChatGPT}>{signingIn ? 'Waiting for sign-in…' : 'Continue with ChatGPT'}</button><button className="secondary" disabled={busy} onClick={() => void act(async()=>{await refreshConnection();})}>Refresh connection</button>{chatgpt?.connected && <button className="secondary" disabled={busy} onClick={() => void act(async()=>{const result=await api<{revocation_confirmed:boolean}>('/auth/chatgpt/disconnect',{method:'POST'}); await refreshConnection(); setNotice(result.revocation_confirmed?'ChatGPT disconnected.':'Disconnected locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.');})}>Disconnect</button>}</div></div></section>
        {view === 'workspace' && <>
          <section className="card"><h2>Create a claim case</h2><form className="row" onSubmit={e => {e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); void act(async () => {const item = await api<ClaimCase>('/cases', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:data.get('title'), claim_reference:data.get('reference')})}); setCases([item,...cases]); await choose(item); form.reset();});}}><label>Case title<input name="title" placeholder="Dengue hospitalization" required maxLength={200}/></label><label>Claim reference<input name="reference" placeholder="SYN-DEN-001" required maxLength={100}/></label><button disabled={busy}>Create case</button></form></section>
          {selected && <><section className="card"><h2>Add evidence</h2><p>Upload the insurer communication first, followed by relevant records, policy wording and acknowledgements.</p><form onSubmit={e => {e.preventDefault(); const form=e.currentTarget; const data = new FormData(form); if (!data.get('logical_id')) data.delete('logical_id'); void act(async () => {await api('/cases/'+selected.id+'/documents',{method:'POST',body:data}); setDocuments(await api<Document[]>('/cases/'+selected.id+'/documents')); form.reset();});}}><div className="row"><label>Document type<select name="kind">{['insurer_communication','clinical','bill','receipt','policy','schedule','endorsement'].map(k => <option key={k} value={k}>{k.replaceAll('_',' ')}</option>)}</select></label><label>Version of<select name="logical_id"><option value="">New document</option>{documents.filter((d,i,a) => a.findIndex(x => x.logical_id===d.logical_id)===i).map(d => <option key={d.logical_id} value={d.logical_id}>{d.filename}</option>)}</select></label><label>PDF or text<input type="file" name="file" accept=".pdf,.txt" required/></label></div><button disabled={busy}>Upload evidence</button></form></section>
          <section className="card"><div className="section-heading"><h2>Document inventory</h2><button disabled={busy || !chatgpt?.connected || !chatgpt.model_available || !documents.some(d=>d.kind==='insurer_communication') || runs.some(item => ['queued','running'].includes(item.status))} onClick={() => void act(async () => {setReport(null); await saveRun(await api<Run>('/cases/'+selected.id+'/analyses',{method:'POST'}));})}>Start analysis</button></div>{documents.length ? <table><thead><tr><th>Document</th><th>Type</th><th>Version</th><th>Extraction</th></tr></thead><tbody>{documents.map(d => <tr key={d.id}><td>{d.filename}</td><td>{d.kind.replaceAll('_',' ')}</td><td>{d.version}</td><td>{d.extraction_status}</td></tr>)}</tbody></table> : <p>No documents uploaded yet.</p>}
          {run && <div role="status" className="progress"><strong>Analysis: {run.status}</strong>{run.report_id && <p><button disabled={busy} onClick={() => void act(() => openReport(run))}>View report</button></p>}{run.error && <p>{run.error}</p>}{run.status==='paused' && <button disabled={busy || !chatgpt?.connected || !chatgpt.model_available} onClick={() => void act(async()=>{await saveRun(await api<Run>('/analyses/'+run.id+'/resume',{method:'POST'}));})}>Resume analysis</button>}</div>}</section><section className="card"><h2>Analysis history</h2><p role="status" className="muted">{liveStatus}</p><p>Previous analyses stay available while a new analysis runs.</p>{runs.length ? <table><thead><tr><th>Started</th><th>Status</th><th>Actions</th></tr></thead><tbody>{runs.map(item => <tr key={item.id}><td>{new Date(item.created_at).toLocaleString()}</td><td><strong>{item.status}</strong>{item.error && <p>{item.error}</p>}</td><td><div className="citations">{item.report_id && <button disabled={busy} onClick={() => void act(() => openReport(item))}>View report</button>}{item.status === 'paused' && <button className="secondary" disabled={busy || !chatgpt?.connected || !chatgpt.model_available} onClick={() => void act(async () => {await saveRun(await api<Run>('/analyses/'+item.id+'/resume', {method:'POST'}));})}>Resume</button>}<button className="secondary" disabled={busy || ['queued','running'].includes(item.status)} onClick={() => void act(() => removeRun(item))}>Delete</button></div></td></tr>)}</tbody></table> : <p>No analyses yet. Start an analysis using the documents above.</p>}</section></>}
        </>}
        {(view === 'report' || view === 'review') && (!report ? <section className="card empty"><h2>Choose a saved report</h2><p>Select a case and open a completed analysis below.</p>{runs.filter(item => item.report_id).map(item => <p key={item.id}><button disabled={busy} onClick={() => void act(() => openReport(item))}>View report — {new Date(item.created_at).toLocaleString()}</button></p>)}{!runs.some(item => item.report_id) && <p>No completed reports for this case yet.</p>}</section> : <>
          <section className="card"><div className="section-heading"><div><h2>Response package · version {report.version}</h2><p>{report.review_required ? 'Some findings need reviewer attention.' : 'Evidence analysis completed.'}</p></div><button onClick={download}>Download package</button></div></section>
          {report.findings.filter(f=>view!=='review'||f.review_required).map(f => <section className="card finding" key={f.request_id}><span className={'badge '+(f.review_required?'warning':'')}>{f.evidence_status.replaceAll('_',' ')}</span><h2>{report.requests.find(r=>r.request_id===f.request_id)?.text}</h2><p className="explanation">{f.explanation}</p><p><strong>Submission:</strong> {f.submission_status.replaceAll('_',' ')}</p><div className="citations">{[...f.evidence_refs,...f.policy_refs,...f.receipt_refs].map((ref,i)=><button className="secondary" key={i} onClick={() => void act(()=>inspect(ref))}>Source {i+1} · v{ref.version} · page {ref.page}</button>)}</div>{f.unresolved_questions.length>0 && <><h3>Unresolved</h3><ul>{f.unresolved_questions.map((q,i)=><li key={i}>{q}</li>)}</ul></>}<div className="next"><strong>Next action</strong><p>{f.next_action}</p></div>
            {view==='review' && <form onSubmit={e=>{e.preventDefault(); const data=new FormData(e.currentTarget); void act(async()=>{await api('/tasks/'+encodeURIComponent(report.run_id+':'+f.request_id)+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:data.get('decision'),rationale:reviewNotes[f.request_id]||''})}); setNotice('Reviewer decision saved to the audit history.');});}}><label>Decision<select name="decision"><option value="approved">Approve finding</option><option value="request_evidence">Request evidence</option><option value="override">Record override</option></select></label><label>Rationale<textarea minLength={10} required value={reviewNotes[f.request_id]||''} onChange={e=>setReviewNotes({...reviewNotes,[f.request_id]:e.target.value})}/></label><button disabled={busy}>Record review</button></form>}
          </section>)}
          {view==='report' && <section className="card"><h2>Response draft</h2><p>Review this draft before sharing it with your insurer.</p><pre>{report.response_draft}</pre></section>}
        </>)}
      </>}
      {preview && <div className="modal" role="dialog" aria-modal="true" aria-label="Source evidence"><section className="card"><div className="section-heading"><h2>Original source · v{preview.ref.version} · page {preview.ref.page}</h2><button className="secondary" onClick={()=>setPreview(null)}>Close</button></div><blockquote>{preview.ref.quote}</blockquote><pre>{preview.text}</pre><button onClick={()=>void act(()=>original(preview.ref))}>Download original version</button></section></div>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
