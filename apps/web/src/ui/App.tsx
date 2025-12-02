import React, { useEffect, useState } from 'react';

type Asset = {
  id: string;
  media_type: 'image' | 'video';
  created_ts: number;
};

export default function App() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState('');

  async function fetchAssets(text?: string) {
    const qs = text ? `?text=${encodeURIComponent(text)}` : '';
    const res = await fetch(`http://localhost:8787/api/assets${qs}`);
    const data = await res.json();
    setAssets(data);
  }

  useEffect(() => {
    fetchAssets(); // initial load
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>PhotoVault Web</h1>
      <p>Backed by the local API. Try searching by year, e.g., “{new Date().getFullYear()}”.</p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Try: 2025"
          style={{ flex: 1, padding: 8, border: '1px solid #ddd', borderRadius: 8 }}
        />
        <button onClick={() => fetchAssets(query)}>Search</button>
        <button onClick={() => { setQuery(''); fetchAssets(); }}>Clear</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {assets.map((a) => (
          <div key={a.id} style={{ aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', background: '#eee', position: 'relative' }}>
            <img
              src={`http://localhost:8787/api/thumb/${a.id}`}
              alt={a.id}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => ((e.currentTarget.style.opacity = '0.5'))}
            />
            <div style={{
              position: 'absolute', bottom: 6, left: 6, padding: '2px 6px',
              background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: 6, fontSize: 12
            }}>
              {a.media_type} · {new Date(a.created_ts).toLocaleDateString()}
            </div>
          </div>
        ))}
      </div>

      {assets.length === 0 && <p style={{ marginTop: 16 }}>No results yet. Try importing media, then refresh.</p>}
    </div>
  );
}
