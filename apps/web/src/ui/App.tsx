import React, { useState } from 'react'

export default function App() {
  const [query, setQuery] = useState('')
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>PhotoVault Web (demo)</h1>
      <p>This is a placeholder UI. Use the CLI to build a vault; serving vault data to web can be added as a simple Fastify API later.</p>
      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Ask e.g. 'italy 2019 videos'" />
        <button onClick={() => alert(`Would query: ${query}`)}>Search</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {[...Array(12)].map((_,i) => <div key={i} style={{ background:'#eee', aspectRatio:'1/1', borderRadius:8 }} />)}
      </div>
    </div>
  )
}
