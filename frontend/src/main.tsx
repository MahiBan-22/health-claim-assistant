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
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.status)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api<Run>('/analyses/' + run.id).then(async current => {
        if (cancelled) return;
        setRun(current);
        if (current.report_id) {
          const completed = await api<Report>('/reports/' + current.report_id);
          if (!cancelled) { setReport(completed); setView('report'); }
        }
      }).catch(e => { if (!cancelled) setError(String(e)); });
    }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [run?.id, run?.status, token]);

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
    setSelected(item); setRun(null); setReport(null); setPreview(null);
    setDocuments(await api<Document[]>('/cases/' + item.id + '/documents'));
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
        <div className="case-bar"><label>Current case<select value={selected?.id || ''} onChange={e => {const item = cases.find(c => c.id === e.target.value); if (item) void act(() => choose(item));}}><option value="">Select a case</option>{cases.map(c => <option key={c.id} value={c.id}>{c.title} · {c.claim_reference}</option>)}</select></label><button className="secondary" onClick={() => {setConnected(false); setToken(''); setSelected(null); setReport(null); setRun(null); setDocuments([]); setPreview(null);}}>Lock workspace</button></div>
        <section className="card"><div className="section-heading"><div><h2>ChatGPT connection</h2><p>{chatgpt?.message || 'Checking the host connection…'}{chatgpt?.email && <><br/>Account: {chatgpt.email}</>}</p></div><div className="citations"><button disabled={busy || signingIn} onClick={connectChatGPT}>{signingIn ? 'Waiting for sign-in…' : 'Continue with ChatGPT'}</button><button className="secondary" disabled={busy} onClick={() => void act(async()=>{await refreshConnection();})}>Refresh connection</button>{chatgpt?.connected && <button className="secondary" disabled={busy} onClick={() => void act(async()=>{const result=await api<{revocation_confirmed:boolean}>('/auth/chatgpt/disconnect',{method:'POST'}); await refreshConnection(); setNotice(result.revocation_confirmed?'ChatGPT disconnected.':'Disconnected locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.');})}>Disconnect</button>}</div></div></section>
        {view === 'workspace' && <>
          <section className="card"><h2>Create a claim case</h2><form className="row" onSubmit={e => {e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); void act(async () => {const item = await api<ClaimCase>('/cases', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:data.get('title'), claim_reference:data.get('reference')})}); setCases([item,...cases]); await choose(item); form.reset();});}}><label>Case title<input name="title" placeholder="Dengue hospitalization" required maxLength={200}/></label><label>Claim reference<input name="reference" placeholder="SYN-DEN-001" required maxLength={100}/></label><button disabled={busy}>Create case</button></form></section>
          {selected && <><section className="card"><h2>Add evidence</h2><p>Upload the insurer communication first, followed by relevant records, policy wording and acknowledgements.</p><form onSubmit={e => {e.preventDefault(); const form=e.currentTarget; const data = new FormData(form); if (!data.get('logical_id')) data.delete('logical_id'); void act(async () => {await api('/cases/'+selected.id+'/documents',{method:'POST',body:data}); setDocuments(await api<Document[]>('/cases/'+selected.id+'/documents')); form.reset();});}}><div className="row"><label>Document type<select name="kind">{['insurer_communication','clinical','bill','receipt','policy','schedule','endorsement'].map(k => <option key={k} value={k}>{k.replaceAll('_',' ')}</option>)}</select></label><label>Version of<select name="logical_id"><option value="">New document</option>{documents.filter((d,i,a) => a.findIndex(x => x.logical_id===d.logical_id)===i).map(d => <option key={d.logical_id} value={d.logical_id}>{d.filename}</option>)}</select></label><label>PDF or text<input type="file" name="file" accept=".pdf,.txt" required/></label></div><button disabled={busy}>Upload evidence</button></form></section>
          <section className="card"><div className="section-heading"><h2>Document inventory</h2><button disabled={busy || !chatgpt?.connected || !chatgpt.model_available || !documents.some(d=>d.kind==='insurer_communication') || !!run && ['queued','running'].includes(run.status)} onClick={() => void act(async () => {setReport(null); setRun(await api<Run>('/cases/'+selected.id+'/analyses',{method:'POST'}));})}>Start analysis</button></div>{documents.length ? <table><thead><tr><th>Document</th><th>Type</th><th>Version</th><th>Extraction</th></tr></thead><tbody>{documents.map(d => <tr key={d.id}><td>{d.filename}</td><td>{d.kind.replaceAll('_',' ')}</td><td>{d.version}</td><td>{d.extraction_status}</td></tr>)}</tbody></table> : <p>No documents uploaded yet.</p>}
          {run && <div role="status" className="progress"><strong>Analysis: {run.status}</strong>{run.error && <p>{run.error}</p>}{run.status==='paused' && <button disabled={busy || !chatgpt?.connected || !chatgpt.model_available} onClick={() => void act(async()=>{setRun(await api<Run>('/analyses/'+run.id+'/resume',{method:'POST'}));})}>Resume analysis</button>}</div>}</section></>}
        </>}
        {(view === 'report' || view === 'review') && (!report ? <section className="card empty"><h2>Your report will appear here</h2><p>Start an analysis from the claim workspace, or open a saved report by its ID.</p><form onSubmit={e => {e.preventDefault(); const id = String(new FormData(e.currentTarget).get('report')); void act(async () => {setPreview(null); setReport(await api<Report>('/reports/'+encodeURIComponent(id)));});}}><label>Report ID<input name="report" required/></label><button disabled={busy}>Open report</button></form></section> : <>
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
