'use client';
import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/components/locale';
export default function MetricInfo({children,name,question,limitations,href,detail}:{children:React.ReactNode;name:string;question:string;limitations:string[];href:string;detail?:React.ReactNode}) {
  const {tt}=useT();const modal=useRef<HTMLDialogElement>(null);const trigger=useRef<HTMLButtonElement>(null);const [open,setOpen]=useState(false);
  useEffect(()=>{if(open)modal.current?.showModal();},[open]);
  return <><button ref={trigger} type="button" className="metric-label" onClick={()=>setOpen(true)} aria-haspopup="dialog">{children}<span aria-hidden="true"> ⓘ</span></button>{open&&createPortal(<dialog ref={modal} className="brief-info" aria-label={name} onClose={()=>{setOpen(false);trigger.current?.focus();}} onClick={e=>{if(e.target===e.currentTarget)modal.current?.close();}}><div className="brief-dialog-head"><strong>{name}</strong><button className="btn btn-outline btn-sm" autoFocus onClick={()=>modal.current?.close()}>{tt('ux.close')}</button></div><p>{question}</p>{detail}<ul>{limitations.map(x=><li key={x}>{x}</li>)}</ul><a href={href} target="_blank" rel="noreferrer">{tt('ux.fullSource')} ↗</a></dialog>,document.body)}</>;
}
