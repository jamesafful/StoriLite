export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="64" y2="64">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="100%" stopColor="#06b6d4" />
          </linearGradient>
        </defs>
        <rect x="6" y="10" width="52" height="40" rx="8" fill="url(#g)" />
        <circle cx="24" cy="30" r="7" fill="#fff" />
        <path d="M18 42l8-8 8 6 8-10 10 12H18z" fill="#fff" opacity="0.9" />
      </svg>
      <span style={{ fontWeight: 700, fontSize: 20 }}>StoriLite</span>
    </div>
  );
}
