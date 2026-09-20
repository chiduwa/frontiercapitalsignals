import test from 'node:test';
import assert from 'node:assert/strict';
import {ALWAYS_TRACKED_OI,selectOiWatchlist} from './scripts/oi-sampler.mjs';
test('all favorites remain sampled when HBAR drops below the top 40',()=>{
 const ranked=['BTC','ETH','SOL','XLM','XRP','HYPE',...Array.from({length:40},(_,i)=>'ASSET'+i),'HBAR'];
 const selected=selectOiWatchlist(ranked,40);assert.equal(selected.length,40);assert.equal(new Set(selected).size,40);assert.deepEqual(selected.slice(0,7),ALWAYS_TRACKED_OI);assert.ok(selected.includes('HBAR'));
});
test('thin rankings and small limits never remove always-tracked coverage',()=>{
 assert.deepEqual(selectOiWatchlist([],1),ALWAYS_TRACKED_OI);assert.deepEqual(selectOiWatchlist(['BTC','BTC']),ALWAYS_TRACKED_OI);assert.equal(selectOiWatchlist(['EXTRA'],NaN).length,8);
});
