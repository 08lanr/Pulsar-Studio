import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { filterTitles } from '@/lib/research/engine';
import { parseMarketFilter, safeReturn, safeSort, normalizeMarkets, toggleDistribution } from '@/lib/research/navigation';
import { fixtureSession } from '@/lib/auth';
import { fixtureData, resetFixtureStore } from '@/lib/data/fixture';
import type { MarketTitle, ResearchProfile } from '@/lib/research/types';
import { sourceByKey, sourceStatus } from '@/lib/research/registry';
const profile: ResearchProfile={tropes:['ceo_billionaire'],audience:'female',distribution:['licensed'],titles_per_year:12,target_markets:['US'],updated_at:'2026-09-07T00:00:00Z'};
afterEach(()=>resetFixtureStore());
test('search finds Chinese/English taxonomy labels and publishers without changing the platform scope',()=>{
 const title:MarketTitle={key:'dramabox-example',platform_id:'example',title:'A new life',blurb:'Starting again.',platform:'dramabox',cover:null,url:'https://example.com',audience:null,episode_count:null,paywall_episode:null,episode_seconds:null,episode_seconds_basis:null,released_at:null,platform_new:false,placements:[],metrics:{views:null,saves:null,rating:null},companies:[{name:'Webfic',role:'publisher',evidence:'observed',via:'author'}],platform_tags:[],tropes:[{id:'ceo_billionaire',evidence:'inferred',via:'synopsis'}]};
 for(const q of ['霸总','CEO','ceo_billionaire','webfic','Ｗｅｂｆｉｃ'])assert.equal(filterTitles([title],{q}).length,1,q);
 assert.equal(filterTitles([title],{q:'webfic',platform:'reelshort'}).length,0);
 assert.equal(filterTitles([title],{q:'does not exist'}).length,0);
});
test('explicit filters override company positioning and All tracked titles removes profile defaults',()=>{
 assert.equal(parseMarketFilter({},profile).audience,'female');
 assert.equal(parseMarketFilter({audience:'male'},profile).audience,'male');
 assert.equal(parseMarketFilter({audience:'all'},profile).audience,'all');
 assert.equal(parseMarketFilter({mode:'all'},profile).audience,'all');
 assert.equal(parseMarketFilter({platform:'invalid',trope:'invalid'},profile).trope,null);
});
test('raw counter sorts require a single platform even for manually entered URLs',()=>{
 for(const sort of ['views','saves']){
   assert.equal(safeSort(sort,'all'),'prominence');
   assert.equal(safeSort(sort,'dramabox'),sort);
 }
});
test('detail return context retains sort and page but cannot navigate outside results',()=>{
 const url='/producer/explore/titles?platform=dramabox&trope=revenge&sort=views&page=2';
 assert.equal(safeReturn(url),url);
 for(const bad of ['//evil.test','https://evil.test','/api/auth/logout','/producer/../api/auth/logout'])assert.equal(safeReturn(bad),'/producer/explore/titles');
});
test('None is exclusive and can be cleared without losing normal distribution choices',()=>{
 assert.deepEqual(toggleDistribution(['licensed','self'],'none'),['none']);
 assert.deepEqual(toggleDistribution(['none'],'youtube'),['youtube']);
 assert.deepEqual(toggleDistribution(['self','licensed'],'self'),['licensed']);
 assert.deepEqual(normalizeMarkets(['US','USA','美国','UK','GB',' ca ']),['US','GB','CA']);
});
test('company identity is tenant scoped and returns only display fields',async()=>{
 const producer=fixtureSession('producer');const company=await fixtureData.getCompanyIdentity(producer);
 assert.equal(company?.id,producer.producerId);
 assert.deepEqual(Object.keys(company!).sort(),['external_id','id','name_en','name_zh']);
 assert.equal(await fixtureData.getCompanyIdentity(fixtureSession('staff')),null);
 assert.equal(await fixtureData.getCompanyIdentity({...producer,producerId:'00000000-0000-4000-8000-00000000ffff'}),null);
 const {updated_at,...input}=profile;
 await fixtureData.saveResearchProfile(producer,input);
 assert.deepEqual((await fixtureData.getResearchProfile(producer))?.tropes,profile.tropes);
 await assert.rejects(fixtureData.saveResearchProfile({...producer,producerRole:'viewer'},input));
});
test('a saved profile does not imply report availability and source failures stay platform specific',async()=>{
 const view=await fixtureData.getMarket(fixtureSession('producer'));
 const ctx={view,hasReports:false,hasProfile:true,now:new Date(view.latest!.platforms[0].fetched_at)};
 assert.equal(sourceStatus(sourceByKey('producer_reports')!,ctx),'manual');
 assert.equal(sourceStatus(sourceByKey('producer_input')!,ctx),'available');
 const failedView={...view,latest:{...view.latest!,platforms:view.latest!.platforms.map(p=>({...p,status:p.id==='dramabox'?'failed' as const:'ok' as const}))}};
 assert.equal(sourceStatus(sourceByKey('dramabox_web')!,{...ctx,view:failedView}),'failed');
 assert.equal(sourceStatus(sourceByKey('reelshort_web')!,{...ctx,view:failedView}),'available');
 assert.equal(sourceStatus(sourceByKey('reelshort_web')!,{...ctx,now:new Date('2099-01-01')}),'stale');
});
