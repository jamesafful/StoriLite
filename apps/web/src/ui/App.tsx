import React, { useEffect, useMemo, useState } from 'react';
import Logo from './Logo';
import Modal from './Modal';

type Asset = {
  id: string;
  media_type: 'image'|'video';
  created_ts: number;
  bytes_orig?: number;
  bytes_vault?: number;
  saved_bytes?: number;
};

function bytes(n?: number) {
  if (!n || n <= 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [apiUp, setApiUp] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number>(0);
  const [compressing, setCompressing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const yearNow = useMemo(() => new Date().getFullYear().toString(), []);

  async function fetchAssets(text?: string) {
    const qs = text ? `?text=${encodeURIComponent(text)}` : '';
    const res = await fetch(`/api/assets${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setAssets(data);
  }

  // Startup: health check + first asset fetch with timeout
  useEffect(() => {
    (async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const h = await fetch('/api/health', { signal: ctl.signal });
        clearTimeout(t);
        if (h.ok) setApiUp(true);
      } catch {
        setApiUp(false);
      }
      try {
        await fetchAssets();
      } catch {
        /* ignore; empty gallery will show */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Upload with real progress (XHR for upload progress events)
  async function uploadFiles(files: FileList) {
    setUploading(true);
    setUploadPct(0);
    await new Promise<void>((resolve, reject) => {
      const fd = new FormData();
      Array.from(files).forEach(f => fd.append('file', f, f.name));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload', true);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Upload failed ${xhr.status}`));
      xhr.onerror = () => reject(new Error('Upload network error'));
      xhr.send(fd);
    });
    setUploading(false);
    setToast('Upload complete. Ready to compress.');
    setTimeout(() => setToast(null), 2500);
  }

  async function onUploadChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    try {
      await uploadFiles(e.target.files);
    } catch (err) {
      console.error(err);
      setToast('Upload failed');
      setTimeout(() => setToast(null), 2500);
    } finally {
      e.currentTarget.value = '';
    }
  }

  async function onCompress(preset: 'standard'|'high'|'max' = 'standard') {
    setCompressing(true);
    try {
      const res = await fetch('/api/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset })
      });
      if (!res.ok) throw new Error(`compress HTTP ${res.status}`);
      const j = await res.json();
      setToast(`Compression done: ${j.converted} item(s)`);
      setTimeout(() => setToast(null), 2500);
      await fetchAssets(query || undefined);
    } catch (e) {
      console.error(e);
      setToast('Compression failed');
      setTimeout(() => setToast(null), 2500);
    } finally {
      setCompressing(false);
    }
  }

  const years = Array.from(new Set(assets.map(a => new Date(a.created_ts).getFullYear().toString()))).sort().reverse();

  // Splash
  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg,#0ea5e9,#7c3aed)' }}>
        <div style={{ textAlign: 'center', color: '#fff' }}>
          <Logo size={48} />
          <div style={{ marginTop: 12, opacity: 0.9 }}>
            {apiUp ? 'Loading your StoriLite…' : 'Starting local API…'}
          </div>
        </div>
      </div>
    );
  }

  const canCompress = (accepted || demoMode) && !uploading && !compressing;

  return (
    <div style={{ fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, sans-serif', background:'#0b1020', minHeight:'100vh', color:'#e5e7eb' }}>
      <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 24px', borderBottom:'1px solid #1f2a44', position:'sticky', top:0, backdropFilter:'blur(8px)' }}>
        <Logo />
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, opacity:0.9 }}>
            <input type="checkbox" checked={demoMode} onChange={(e)=>setDemoMode(e.target.checked)} />
            Demo mode (bypass T&C)
          </label>
          {!user ? (
            <button
              onClick={() => setUser({ email: 'demo@googleuser.com' })} // mock sign-in
              style={{ padding:'8px 12px', borderRadius:8, background:'#22c55e', color:'#0b1020', border:'none', fontWeight:600 }}
              title="Mock Google Sign-In (no real OAuth here)"
            >
              Sign in with Google
            </button>
          ) : (
            <div style={{ fontSize:14, opacity:0.9 }}>Signed in as {user.email}</div>
          )}
        </div>
      </header>

      {/* Welcome card + T&C */}
      {!accepted && !demoMode && (
        <div style={{ maxWidth: 840, margin:'24px auto', background:'#0f172a', border:'1px solid #1f2a44', borderRadius:16, padding:24 }}>
          <h2 style={{ marginTop:0 }}>Welcome to StoriLite</h2>
          <p>Free up space without losing memories. Everything processes locally via your Codespace API.</p>
          <ul>
            <li>Upload photos/videos below</li>
            <li>Click <b>Compress</b> to optimize and catalog</li>
            <li>Browse your gallery; search by year</li>
          </ul>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:12 }}>
            <input type="checkbox" checked={accepted} onChange={(e)=>setAccepted(e.target.checked)} id="tac" />
            <label htmlFor="tac">
              I agree to the{' '}
              <a href="#terms" style={{ color:'#60a5fa' }} onClick={(e)=>{ e.preventDefault(); setShowTerms(true); }}>
                Terms & Conditions
              </a>{' '}
              and understand media stays local in this demo.
            </label>
          </div>
        </div>
      )}

      <Modal open={showTerms} onClose={()=>setShowTerms(false)}>
        <p><b>StoriLite Demo Terms</b></p>
        <ol>
          <li>This demo processes media locally using your dev environment. No uploads to external servers.</li>
          <li>Backups are stored under <code>.vault/backups</code>. Do not delete if you plan to restore originals.</li>
          <li>By clicking Accept, you authorize local processing and disk I/O on your machine.</li>
        </ol>
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:12 }}>
          <button onClick={()=>setShowTerms(false)} style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #334155', background:'transparent', color:'#e5e7eb' }}>Close</button>
          <button onClick={()=>{ setAccepted(true); setShowTerms(false); }} style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #334155', background:'#22c55e', color:'#0b1020', fontWeight:700 }}>Accept</button>
        </div>
      </Modal>

      <main style={{ maxWidth: 1200, margin:'0 auto', padding:24 }}>
        <section style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:16, marginBottom:24 }}>
          <div style={{ background:'#0f172a', border:'1px solid #1f2a44', borderRadius:16, padding:16 }}>
            <h3 style={{ marginTop:0 }}>Upload</h3>
            <p style={{ opacity:0.9, marginTop:8 }}>Select photos/videos to stage them for compression.</p>
            <input type="file" multiple onChange={onUploadChange} style={{ marginTop:12 }} />
            {uploading && (
              <div style={{ marginTop:10, fontSize:13 }}>
                Uploading… {uploadPct}%
                <div style={{ height:6, background:'#1f2a44', borderRadius:6, marginTop:6 }}>
                  <div style={{ height:'100%', width:`${uploadPct}%`, background:'#60a5fa', borderRadius:6 }} />
                </div>
              </div>
            )}

            <div style={{ display:'flex', gap:8, marginTop:16, flexWrap:'wrap' }}>
              <button
                disabled={!canCompress}
                onClick={() => onCompress('standard')}
                style={{ padding:'10px 14px', borderRadius:10, border:'1px solid #334155',
                         background: canCompress ? '#22c55e' : '#334155',
                         color: canCompress ? '#0b1020' : '#94a3b8', fontWeight:700 }}
                title={!canCompress ? 'Accept T&C or enable Demo mode' : 'Compress with Standard quality'}
              >Compress (Standard)</button>

              <button
                disabled={!canCompress}
                onClick={() => onCompress('high')}
                style={{ padding:'10px 14px', borderRadius:10, border:'1px solid #334155',
                         background: canCompress ? '#a78bfa' : '#334155',
                         color: canCompress ? '#0b1020' : '#94a3b8', fontWeight:700 }}
              >High</button>

              <button
                disabled={!canCompress}
                onClick={() => onCompress('max')}
                style={{ padding:'10px 14px', borderRadius:10, border:'1px solid #334155',
                         background: canCompress ? '#38bdf8' : '#334155',
                         color: canCompress ? '#0b1020' : '#94a3b8', fontWeight:700 }}
              >Max</button>
            </div>

            {compressing && <div style={{ marginTop:10, fontSize:13 }}>Compressing… (server-side)</div>}
            {toast && <div style={{ marginTop:10, fontSize:13, color:'#22c55e' }}>{toast}</div>}
          </div>

          <div style={{ background:'#0f172a', border:'1px solid #1f2a44', borderRadius:16, padding:16 }}>
            <h3 style={{ marginTop:0 }}>Search</h3>
            <div style={{ display:'flex', gap:8, marginTop:8 }}>
              <input
                value={query}
                onChange={(e)=>setQuery(e.target.value)}
                placeholder={`Try: ${yearNow}`}
                style={{ flex:1, padding:10, borderRadius:10, border:'1px solid #334155', background:'#0b1020', color:'#e5e7eb' }}
              />
              <button onClick={()=>fetchAssets(query)} style={{ padding:'10px 14px', borderRadius:10, border:'1px solid #334155', background:'#334155', color:'#e5e7eb' }}>Search</button>
              <button onClick={()=>{ setQuery(''); fetchAssets(); }} style={{ padding:'10px 14px', borderRadius:10, border:'1px solid #334155', background:'transparent', color:'#94a3b8' }}>Clear</button>
            </div>
            <div style={{ display:'flex', gap:8, marginTop:12, flexWrap:'wrap' }}>
              {years.map(y => (
                <button key={y} onClick={()=>fetchAssets(y)} style={{ padding:'6px 10px', borderRadius:999, border:'1px solid #334155', background:'#0b1020', color:'#cbd5e1' }}>{y}</button>
              ))}
            </div>
          </div>
        </section>

        <section style={{ background:'#0f172a', border:'1px solid #1f2a44', borderRadius:16, padding:16 }}>
          <h3 style={{ marginTop:0 }}>Your Gallery</h3>
          {assets.length === 0 ? (
            <p style={{ opacity:0.9 }}>No results yet. Upload files, click <b>Compress</b>, then refresh.</p>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(8, 1fr)', gap:8 }}>
              {assets.map(a => (
                <figure key={a.id} style={{ aspectRatio:'1/1', background:'#111827', borderRadius:10, overflow:'hidden', margin:0, position:'relative' }}>
                  <img src={`/api/thumb/${a.id}`} alt={a.id} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                  <figcaption style={{ position:'absolute', bottom:6, left:6, right:6, display:'flex', justifyContent:'space-between', fontSize:12, background:'rgba(0,0,0,0.4)', padding:'2px 6px', borderRadius:6 }}>
                    <span>{a.media_type} · {new Date(a.created_ts).toLocaleDateString()}</span>
                    <span>saved {bytes(a.saved_bytes)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
