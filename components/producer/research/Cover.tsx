'use client';
import { useState } from 'react';
export default function Cover({ src, title, className = 'brief-cover' }: {src: string | null; title: string; className?: string}) {
  const [failed, setFailed] = useState(false);
  // External platform covers are not proxied; preserve direct source URLs and handle failures locally.
  // eslint-disable-next-line @next/next/no-img-element
  return src && !failed ? <img className={className} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(true)} /> : <span className={`${className} cover-fallback`} aria-hidden="true">{title.slice(0, 2)}</span>;
}
