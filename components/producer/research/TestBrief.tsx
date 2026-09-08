'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/components/locale';
import { postJson } from '@/lib/api-client';
import { unwrap, type ApiEnvelope } from '@/components/workbench/util';
import type { PromoCampaign } from '@/lib/types';

export default function TestBrief({titleId,name,readOnly}:{titleId:string;name:string;readOnly:boolean}) {
  const {tt}=useT(); const router=useRouter();
  const [budget,setBudget]=useState('100'); const [hypothesis,setHypothesis]=useState('');
  const [audience,setAudience]=useState(''); const [destination,setDestination]=useState('');
  const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  async function submit(event:React.FormEvent) {
    event.preventDefault(); if(busy||readOnly)return; setBusy(true);setError('');
    try {
      const result=unwrap(await postJson<{campaign?:PromoCampaign}&ApiEnvelope>('/api/producer/promote',{
        title_id:titleId,name:`${name.slice(0,75)} — US concept test`,target_market:'US',objective:'views',spoiler_level:'low',
        destination_url:destination.trim()||null,
        creative_direction:`US concept test. Proposed total USD ${budget} (planning only; not an enforced cap). Audience: ${audience.trim()}. Hypothesis: ${hypothesis.trim()}. First batch: 2 packaging angles; same audience and destination. No paid launch authorized by this brief.`,
      })); router.push(`/producer/promote/${result.campaign!.id}`);router.refresh();
    } catch(e) {setError((e as Error).message);setBusy(false);}
  }
  return <form className="rs-panel launch-test" onSubmit={submit}><h3>{tt('launch.plan')}</h3><p>{tt('launch.planNote')}</p>
    <label htmlFor="test-budget">{tt('launch.budget')}</label><input id="test-budget" className="input" type="number" min="1" max="100000" step="1" required value={budget} onChange={e=>setBudget(e.target.value)}/>
    <p>{tt('launch.budgetNote')}</p>
    <label htmlFor="test-audience">{tt('launch.audience')}</label><input id="test-audience" className="input" maxLength={150} required value={audience} onChange={e=>setAudience(e.target.value)}/>
    <label htmlFor="test-hypothesis">{tt('launch.hypothesis')}</label><textarea id="test-hypothesis" className="textarea" maxLength={300} required value={hypothesis} onChange={e=>setHypothesis(e.target.value)}/>
    <label htmlFor="test-destination">{tt('launch.destination')}</label><input id="test-destination" className="input" type="url" value={destination} onChange={e=>setDestination(e.target.value)}/>
    <p>{tt('launch.variants')}</p><p>{tt('launch.signal')}</p><p className="note note-info">{tt('launch.mock')}</p>
    {error&&<p role="alert" className="err">{error}</p>}<button className="btn btn-primary" disabled={busy||readOnly||!hypothesis.trim()||!audience.trim()}>{busy?tt('common.loading'):tt('launch.save')}</button>
  </form>;
}
