import React from 'react';

export default function Modal({
  open,
  onClose,
  children
}: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', display:'grid', placeItems:'center', zIndex:1000 }}>
      <div style={{ background:'#0f172a', border:'1px solid #1f2a44', color:'#e5e7eb', borderRadius:16, width:680, maxWidth:'92vw', padding:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
          <h3 style={{ margin:0 }}>Terms & Conditions</h3>
          <button onClick={onClose} style={{ border:'none', background:'transparent', color:'#94a3b8', fontSize:18 }}>✕</button>
        </div>
        <div style={{ maxHeight:'60vh', overflow:'auto', lineHeight:1.5 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
