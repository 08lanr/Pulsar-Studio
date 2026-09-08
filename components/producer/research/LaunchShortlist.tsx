import { t, type Locale } from '@/lib/i18n';
import { experimentStage, type WorkspaceTitle } from '@/lib/research/workspace';

export default function LaunchShortlist({titles,locale}:{titles:WorkspaceTitle[];locale:Locale}) {
  return <div className="launch-shortlist">{titles.map(x=>{
    const base=`/producer/titles/${x.summary.id}`;
    const campaign=[...x.campaigns].sort((a,b)=>b.updated_at.localeCompare(a.updated_at))[0];
    const stage=campaign?experimentStage(campaign,x.results):null;
    const hasResults=campaign&&x.results.some(r=>r.campaign_id===campaign.id);
    const action=hasResults?'ws.actions.results':stage?.waiting==='generate'?'ws.actions.generateAds':stage?.waiting==='select'?'ws.actions.reviewAds':stage?.waiting==='budget'?'ws.actions.reviewBudget':stage?.waiting==='submit'?'ws.actions.reviewLaunch':campaign?'ws.actions.campaignStatus':!x.facts.episodes_with_video?'ws.actions.materials':'ws.actions.test';
    const href=campaign?`/producer/promote/${campaign.id}`:!x.facts.episodes_with_video?base:`/producer/promote/new?title=${x.summary.id}`;
    return <article className="launch-shortlist-row" key={x.summary.id}>
      <div className="launch-shortlist-title"><a href={`${base}/preparation`}>{locale==='en'?x.summary.name_en||x.summary.name_zh:x.summary.name_zh}</a>{locale==='en'&&x.summary.name_en&&<small lang="zh-CN">{x.summary.name_zh}</small>}</div>
      <div className="launch-shortlist-status"><span>{t(locale,hasResults?(x.results.filter(r=>r.campaign_id===campaign!.id).every(r=>r.source==='demo')?'ws.card.demoResults':'ws.card.results'):campaign?'ws.card.campaign':!x.facts.episodes_with_video?'ws.card.noVideo':'ws.card.noCampaign')}</span><a href={`${base}/preparation`}>{t(locale,'ws.actions.assess')} →</a></div>
      <a className="btn btn-outline" href={href}>{t(locale,action)} →</a>
    </article>;
  })}</div>;
}
