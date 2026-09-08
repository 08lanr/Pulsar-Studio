'use client';

import { useState } from 'react';
import { useT } from '@/components/locale';

const concepts = [
  { id: 'contract', search: 'billionaire' },
  { id: 'receipt', search: 'revenge' },
  { id: 'midnight', search: 'time travel' },
] as const;

export default function ProducerSimulation() {
  const { tt } = useT();
  const [selected, setSelected] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const copy = (key: string) => tt(`sim.${key}`);
  function download() {
    const text = [copy('notice'), copy('title'), copy('mission'), copy('resourcesBody'),
      copy(`${selected}.name`), copy(`${selected}.premise`),
      `${copy('fit')}: ${copy(`${selected}.fit`)}`,
      `${copy('risk')}: ${copy(`${selected}.risk`)}`,
      `${copy('test')}: ${copy(`${selected}.test`)}`,
      `${copy('reason')}: ${notes[selected] || ''}`, copy('inferenceBody')].join('\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `harborlight-${selected}-decision.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="producer-simulation">
    <p className="note note-info">{copy('notice')}</p>
    <section className="rs-panel"><h2>{copy('brief')}</h2><p>{copy('mission')}</p></section>
    <section className="rs-panel"><h2>{copy('profile')}</h2><p>{copy('identity')}</p>
      {['audience', 'resources', 'slate'].map(key => <div key={key}><h3>{copy(key)}</h3><p>{copy(`${key}Body`)}</p></div>)}
    </section>
    <section className="rs-panel"><h2>{copy('workflow')}</h2><p>{copy('workflowBody')}</p></section>
    <h2>{copy('concepts')}</h2>
    <div className="simulation-slate">{concepts.map(({ id, search }) => <article className="rs-panel" key={id}>
      <h3>{copy(`${id}.name`)}</h3><p>{copy(`${id}.premise`)}</p>
      {['fit', 'risk', 'test'].map(key => <div key={key}><h4>{copy(key)}</h4><p>{copy(`${id}.${key}`)}</p></div>)}
      <details><summary>{copy('script')}</summary><pre lang="en" className="simulation-script">{copy(`${id}.script`)}</pre></details>
      <a href={`/producer/explore/titles?q=${encodeURIComponent(search)}`} target="_blank" rel="noreferrer">{copy('market')} ↗</a>
      <button className={`btn ${selected === id ? 'btn-primary' : ''}`} aria-pressed={selected === id} onClick={() => setSelected(id)}>{copy(selected === id ? 'selected' : 'choose')}</button>
    </article>)}</div>
    <section className="rs-panel" aria-labelledby="simulation-decision"><h2 id="simulation-decision">{copy('decision')}</h2>
      {selected ? <><h3>{copy(`${selected}.name`)}</h3><label htmlFor="simulation-notes">{copy('reason')}</label>
        <textarea id="simulation-notes" rows={5} value={notes[selected] || ''} placeholder={copy('placeholder')} onChange={event => setNotes({ ...notes, [selected]: event.target.value })}/>
        <button className="btn btn-primary" onClick={download}>{copy('download')}</button></> : <p>{copy('empty')}</p>}
      <p className="muted">{copy('temporary')}</p>
    </section>
    <section className="rs-panel"><h2>{copy('inference')}</h2><p>{copy('inferenceBody')}</p></section>
  </div>;
}
