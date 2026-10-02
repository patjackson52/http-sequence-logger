import test from 'node:test';
import assert from 'node:assert/strict';
import {projectComparison,restorePair,swapProfile} from '../viewer/src/comparison-state.mjs';
const ref=(id)=>({node_id:id,event_ids:[id+'-event'],label:id,kind:'http'});
const pair=(id,parent,extra={})=>({id,parent_pair_id:parent,primary:ref(id),secondary:ref('s'+id),presence:'both',equivalence:'equal',changes:[],uncertainties:[],...extra});
const diff={pairs:[pair('root',null),pair('equal','root'),pair('change','root',{changes:[{path:'/request/value'}]}),pair('unknown','root',{uncertainties:[{reason:'redacted'}]}),pair('unresolved','root',{secondary:null,presence:'unresolved',uncertainties:[{reason:'ambiguous'}]})],order_changes:[]};
test('presentation preserves ancestry and unknown-only discovery without recomputing',()=>{
 const before=JSON.stringify(diff),changed=projectComparison(diff,{filter:'changed'});
 assert.deepEqual([...changed.visibleIds],['change','root']);assert.equal(changed.hiddenCount,3);
 assert.deepEqual(projectComparison(diff,{filter:'unknown-only'}).navigable.map(p=>p.id),['root','unknown']);
 assert.deepEqual(projectComparison(diff,{collapseEqual:true}).navigable.map(p=>p.id),['root','change','unknown','unresolved']);
 assert.equal(JSON.stringify(diff),before);
});
test('collapse and filtering are independent; empty remains empty',()=>{
 assert.deepEqual(projectComparison(diff,{collapsed:new Set(['root'])}).navigable.map(p=>p.id),['root']);
 assert.equal(projectComparison(diff,{search:'missing'}).navigable.length,0);
 assert.equal(projectComparison(diff,{collapseEqual:true,selectedId:'equal'}).visibleIds.has('equal'),true);
});
test('selection survives profile pair IDs and swap by source identity, not reused IDs',()=>{
 const old=diff.pairs[2],next={pairs:[{...old,id:'new'}]};
 assert.equal(restorePair(old,next),'new');
 assert.equal(restorePair(old,{pairs:[{...old,id:'swap',primary:old.secondary,secondary:old.primary}]},true),'swap');
 assert.equal(restorePair(old,{pairs:[{...old,primary:{...old.primary,event_ids:['other']},secondary:null}]}),null);
 assert.deepEqual(swapProfile({matches:[{primary:'p',secondary:'s'}],recording_matches:[]}).matches,[{primary:'s',secondary:'p'}]);
});
