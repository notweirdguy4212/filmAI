'use client'

interface BrandLogoShapeProps { uid: string; size?: number; className?: string; title?: string }

/** filmAI's signature mark: a luminous film frame wrapped around a play symbol. */
export function BrandLogoShape({ uid, size = 120, className, title }: BrandLogoShapeProps) {
  const gradient = `${uid}-film-gradient`
  const glow = `${uid}-film-glow`
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" role={title ? 'img' : 'presentation'} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={gradient} x1="12" y1="10" x2="108" y2="112" gradientUnits="userSpaceOnUse"><stop stopColor="#22D3EE"/><stop offset=".48" stopColor="#4778FF"/><stop offset="1" stopColor="#B34BFF"/></linearGradient>
        <filter id={glow} x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <g className="filmai-logo-art" filter={`url(#${glow})`}>
        <rect x="13" y="17" width="94" height="86" rx="22" stroke={`url(#${gradient})`} strokeWidth="8"/>
        <path d="M23 35H97M23 85H97" stroke={`url(#${gradient})`} strokeWidth="5" strokeLinecap="round" opacity=".9"/>
        <path d="M50 43.5C50 40.4 53.4 38.5 56.1 40.1L79.4 54.6C82 56.2 82 60 79.4 61.6L56.1 76.1C53.4 77.8 50 75.8 50 72.7V43.5Z" fill={`url(#${gradient})`}/>
        <g fill="#DDFBFF"><rect x="27" y="23" width="8" height="6" rx="2"/><rect x="43" y="23" width="8" height="6" rx="2"/><rect x="69" y="23" width="8" height="6" rx="2"/><rect x="85" y="23" width="8" height="6" rx="2"/><rect x="27" y="91" width="8" height="6" rx="2"/><rect x="43" y="91" width="8" height="6" rx="2"/><rect x="69" y="91" width="8" height="6" rx="2"/><rect x="85" y="91" width="8" height="6" rx="2"/></g>
      </g>
    </svg>
  )
}
