'use client';
import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/components/locale';
import { containDialogFocus } from '@/components/dialog-focus';
export default function MetricInfo({children,name,question,limitations,href,detail}:{children:React.ReactNode;name:string;question:string;limitations:string[];href:string;detail?:React.ReactNode}) {
  const {tt}=useT();const modal=useRef<HTMLDialogElement>(null);const trigger=useRef<HTMLButtonElement>(null);const [open,setOpen]=useState(false);
  useEffect(()=>{if(open)modal.current?.showModal();},[open]);
  return <><button ref={trigger} type="button" className="metric-label" onClick={()=>setOpen(true)} aria-haspopup="dialog">{children}<svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor"/><path d="M8 7v5M8 4v1" stroke="currentColor" strokeWidth="1.5"/></svg></button>{open&&createPortal(<dialog onKeyDown={containDialogFocus} ref={modal} className="brief-info" aria-label={name} onClose={()=>{setOpen(false);trigger.current?.focus();}} onClick={e=>{if(e.target===e.currentTarget)modal.current?.close();}}><div className="brief-dialog-head"><strong>{name}</strong><button className="btn btn-outline btn-sm" autoFocus onClick={()=>modal.current?.close()}>{tt('ux.close')}</button></div><p>{question}</p>{detail}<ul>{limitations.map(x=><li key={x}>{x}</li>)}</ul><a href={href} target="_blank" rel="noreferrer">{tt('ux.fullSource')} ↗</a></dialog>,document.body)}</>;
}
