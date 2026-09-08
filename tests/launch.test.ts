import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { assessLaunch } from '@/lib/research/launch';
import { safeReturn } from '@/lib/research/navigation';
import { fixtureData, resetFixtureStore } from '@/lib/data/fixture';
import { producer } from './seed-minute';

afterEach(()=>resetFixtureStore());
test('launch assessment never derives US response from title metadata',()=>{
 const a=assessLaunch({id:'a',name_zh:'霸总',name_en:'Billionaire',genre:null,synopsis_en:null,synopsis_zh:null},[]);
 assert.equal(a.hasSynopsis,false);assert.deepEqual(a.tags,[]);assert.equal(a.audienceResponse,'untested');assert.deepEqual(a.comparables,[]);
});
test('market insight filters survive title return navigation',()=>{
 assert.equal(safeReturn('/producer/insights?platform=reelshort&audience=female'),'/producer/insights?platform=reelshort&audience=female');
 assert.equal(safeReturn('https://evil.test/producer/insights'),'/producer/explore/titles');
});
test('a no-video test brief persists as draft without permitting video generation',async()=>{
 const title=await fixtureData.createTitle(producer(),{producer_id:'ignored',name_zh:'已有作品'});
 const c=await fixtureData.createPromoCampaign(producer(),{title_id:title.id,name:'US test',target_market:'US',objective:'views',spoiler_level:'low',creative_direction:'Proposed total USD 100; planning only.'});
 const d=await fixtureData.getPromoCampaign(producer(),c.id);
 assert.equal(d.campaign.status,'draft');assert.equal(d.episodes.length,0);assert.equal(d.campaign.creative_direction,c.creative_direction);
 await assert.rejects(fixtureData.generatePromoDrafts(producer(),c.id),/video/);
 assert.equal((await fixtureData.getPromoCampaign(producer(),c.id)).campaign.status,'draft');
});
