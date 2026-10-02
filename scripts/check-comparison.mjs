import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build, preview } from 'vite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { diffSequences, validateDiff } from '../sequence-diff/index.mjs';
import { validateSourceReferences } from '../viewer/src/comparison-data.mjs';
import { startCollector } from '../collector/server.mjs';
import { comparisonFixture, ndjsonOf } from '../test/comparison-fixtures.mjs';

const artifacts=resolve(process.env.COMPARISON_ARTIFACTS||'artifacts/comparison');
const privateDir=await mkdtemp(join(tmpdir(),'comparison-browser-'));
const evidence={kind:'Canonical fixtures in installed Chrome, production viewer, real retained SQLite collector and SSE; no native device execution claimed.',scenarios:[],errors:[],screenshots:[]};
await mkdir(artifacts,{recursive:true});
let browser,server,collector;
const primary=comparisonFixture(['/unknown','/config','/repeat','/repeat','/verify','/gone'],'primary');
const secondary=comparisonFixture(['/unknown','/verify','/repeat','/repeat','/config','/added'],'secondary',{query:true});
const expected=diffSequences(primary,secondary);
assert.equal(expected.result,'different');assert.equal(expected.summary.unresolved,4);assert.equal(expected.summary.primary_only,1);assert.equal(expected.summary.secondary_only,1);
assert.ok(expected.order_changes.some(order=>order.interpretation==='reordered'));
assert.ok(expected.pairs.some(pair=>pair.primary?.label.endsWith('/config')&&pair.equivalence==='unknown'&&!pair.changes.length));

try{
  const configFile=resolve('viewer/vite.config.mjs');await build({configFile,logLevel:'error'});
  server=await preview({configFile,preview:{port:0,host:'127.0.0.1',strictPort:false},logLevel:'error'});
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({channel:process.env.WEB_TEST_CHANNEL||'chrome',headless:true});evidence.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();page.on('pageerror',error=>evidence.errors.push(error.message));
  async function screenshot(name){const file=join(artifacts,name+'.png');await page.screenshot({path:file,fullPage:true});evidence.screenshots.push(name+'.png');}
  async function exportJSON(label,name){const download=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();const result=await download;const path=join(artifacts,name);await result.saveAs(path);return JSON.parse(await readFile(path,'utf8'));}
  async function closeInspector(){const close=page.getByRole('button',{name:'Close paired inspector',exact:true});if(await close.count())await close.click();}
  async function selectPair(id){await page.locator(`.nll-cmp-layouts [data-pair-id="${id}"]`).first().click();await expect(page.locator('.pair-inspector-head code')).toHaveText(id);}
  async function assertExport(name,expectedDiff){await closeInspector();const output=await exportJSON('Export JSON',name+'.diff.json');const snapshots=await exportJSON('Export snapshots',name+'.snapshots.json');assert.equal(validateDiff(output),true);validateSourceReferences(output,snapshots.primary,snapshots.secondary);assert.deepEqual(output,diffSequences(snapshots.primary,snapshots.secondary,output.profile));if(expectedDiff)assert.deepEqual(output,expectedDiff);await expect(page.getByLabel('Comparison summary')).toContainText(`${output.summary.unresolved} unresolved`);return {output,snapshots};}
  await page.goto(origin);await page.getByLabel('Choose NDJSON files',{exact:true}).setInputFiles({name:'primary.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(ndjsonOf(primary))});
  await page.locator('.import-session').first().getByRole('button',{name:'Open',exact:true}).click();
  await page.getByRole('button',{name:'Compare with…',exact:true}).click();
  await page.getByLabel('Import secondary files',{exact:true}).setInputFiles({name:'invalid.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(ndjsonOf(secondary)+'{')});
  await expect(page.getByRole('dialog',{name:'Choose secondary session'})).toContainText('invalid or skipped');
  await page.getByLabel('Import secondary files',{exact:true}).setInputFiles({name:'secondary.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(ndjsonOf(secondary))});
  await page.locator('.comparison-session-option').filter({hasText:'comparison/development / secondary'}).click();
  await expect(page.getByLabel('Comparison summary')).toContainText('Different with uncertainty');
  await expect(page.getByLabel('Comparison findings',{exact:true})).toBeFocused();
  await assertExport('file-original',expected);evidence.scenarios.push('File import including strict malformed-final-line rejection; browser worker/module/export parity and source references.');
  const pickerTrigger=page.getByRole('button',{name:'Compare with…',exact:true});
  const oversized=comparisonFixture(['/same'],'limit');
  const first=oversized.events[0],last=oversized.events.at(-1);last.data.dropped_events=20001;
  oversized.events=[first,...Array.from({length:20001},(_,index)=>({...first,event_type:'capture.gap',event_id:'limit-gap-'+index,data:{dropped_events:1,reason:'test gap'}})),last];
  oversized.events.forEach((event,index)=>{event.sequence=index+1;event.monotonic_ns=String(index*1000000);event.timestamp=new Date(Date.UTC(2026,9,1)+index).toISOString();});
  await pickerTrigger.click();await page.getByLabel('Import secondary files',{exact:true}).setInputFiles({name:'limit.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(ndjsonOf(oversized))});
  await expect(page.getByRole('dialog',{name:'Choose secondary session',exact:true})).toContainText('20000 event limit');
  await page.getByRole('dialog',{name:'Choose secondary session',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
  await assertExport('file-after-limit',expected);evidence.scenarios.push('Oversized canonical import reports the 20000-event limit without publishing a partial snapshot or replacing the last valid comparison.');
  await pickerTrigger.click();await page.getByRole('dialog',{name:'Choose secondary session',exact:true}).getByRole('button',{name:'Close',exact:true}).click();await expect(pickerTrigger).toBeFocused();
  await pickerTrigger.click();await page.keyboard.press('Escape');await expect(pickerTrigger).toBeFocused();
  const selected=expected.pairs.find(pair=>pair.primary?.label.endsWith('/verify')&&pair.secondary).id;
  await selectPair(selected);await page.getByRole('tab',{name:'Request',exact:true}).click();
  await expect(page.locator('.pair-inspector-content')).toContainText('value=secondary');
  for(const [layout,name] of [['outline','Change outline'],['connections','Order connections'],['aligned','Aligned sequences']]){
    await closeInspector();await page.getByRole('tab',{name,exact:true}).click();await selectPair(selected);
    await expect(page.getByRole('tab',{name:'Request',exact:true})).toHaveAttribute('aria-selected','true');await screenshot('1440-'+layout);
  }
  await closeInspector();await page.getByRole('tab',{name:'Change outline',exact:true}).click();
  await page.getByLabel('Comparison filter',{exact:true}).selectOption('unknown-only');await expect(page.locator('.nll-cmp-outline')).toContainText('/unknown');
  await page.getByLabel('Search both sessions',{exact:true}).fill('this-does-not-exist');await expect(page.getByRole('heading',{name:'No comparison findings match',exact:true})).toBeVisible();
  await page.getByLabel('Search both sessions',{exact:true}).press('j');await expect(page.getByLabel('Search both sessions',{exact:true})).toHaveValue('this-does-not-existj');
  await page.getByLabel('Search both sessions',{exact:true}).fill('');await page.getByLabel('Comparison filter',{exact:true}).selectOption('all');
  await page.getByRole('button',{name:'Collapse unchanged',exact:true}).click();await expect(page.locator('.comparison-hidden')).toContainText('hidden');
  await page.getByRole('button',{name:'Next difference',exact:true}).click();await expect(page.locator('.nll-cmp-layouts .is-selected')).not.toHaveCount(0);
  await page.getByRole('button',{name:'Collapse unchanged',exact:true}).click();
  await page.getByRole('button',{name:/Find unknown-only/}).click();await expect(page.locator('.nll-cmp-layouts .is-selected')).toContainText('/unknown');
  await page.getByLabel('Comparison findings',{exact:true}).focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await expect(page.getByLabel('Paired details inspector',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await expect(page.getByLabel('Paired details inspector',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Swap primary and secondary',exact:true}).click();await expect(page.locator('.comparison-identity.primary')).toContainText('/ secondary');
  await assertExport('file-swapped',diffSequences(secondary,primary));
  await page.getByRole('button',{name:'Swap primary and secondary',exact:true}).click();await expect(page.locator('.comparison-identity.primary')).toContainText('/ primary');
  evidence.scenarios.push('One shared selected pair/Request tab across three layouts; unknown-only, filtered-empty, text-input shortcut isolation, collapse, difference navigation, keyboard, swap.');
  await page.getByRole('tab',{name:'Change outline',exact:true}).click();
  const unresolved=expected.pairs.find(pair=>pair.primary?.label.endsWith('/repeat')&&pair.presence==='unresolved');
  await selectPair(unresolved.id);await page.getByRole('tab',{name:'Changes',exact:true}).click();await page.getByRole('button',{name:'Resolve match…',exact:true}).click();
  const match=page.getByRole('dialog',{name:'Resolve match',exact:true});await match.getByRole('radio').filter({visible:true}).first().check();
  assert.ok(await page.locator('.nll-cmp-layouts .is-resolving').count());
  const animation=await page.locator('.nll-cmp-layouts .is-resolving').first().evaluate(element=>getComputedStyle(element).animationName);assert.equal(animation,'none');await screenshot('1440-match-preview');
  await page.emulateMedia({reducedMotion:'no-preference'});assert.equal(await page.locator('.nll-cmp-layouts .is-resolving').first().evaluate(element=>getComputedStyle(element).animationName),'nll-match-pulse');await page.emulateMedia({reducedMotion:'reduce'});
  await match.getByRole('button',{name:'Apply explicit match and recompute',exact:true}).click();await expect(match).toHaveCount(0);
  const resolved=await assertExport('file-resolved');assert.equal(resolved.output.profile.matches.length,1);assert.ok(resolved.output.summary.unresolved<expected.summary.unresolved);
  await screenshot('1440-explicit-resolution');
  evidence.scenarios.push('Ambiguous repeated calls stay unresolved; valid candidate preview uses reduced-motion amber treatment; explicit match applies through engine profile and export.');
  for(const width of [1024,390]){
    await page.setViewportSize({width,height:width===390?844:1000});
    for(const [layout,name] of [['aligned','Aligned sequences'],['outline','Change outline'],['connections','Order connections']]){
      await closeInspector();await page.getByRole('tab',{name,exact:true}).click();await expect(page.locator('.nll-cmp-layouts')).toHaveAttribute('data-layout',layout);await selectPair(selected);
      await expect(page.getByRole('dialog',{name:'Paired details',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'Evidence',exact:true})).toBeVisible();
      await page.getByRole('tab',{name:'Evidence',exact:true}).click();await expect(page.locator('.pair-inspector-content')).toContainText('Pointer and event ID verified');
      await page.getByRole('button',{name:'Copy finding',exact:true}).click();
      const finding=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));assert.equal(finding.pair_id,selected);assert.ok(finding.sources.primary.evidence.every(item=>item.event_id));await screenshot(`${width}-${layout}-inspector`);
      await closeInspector();await screenshot(`${width}-${layout}`);
    }
    const geometry=await page.locator('.comparison-workspace').evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));assert.ok(geometry.scroll<=width+1,`Unintentional whole-workspace overflow at ${width}: ${JSON.stringify(geometry)}`);
  }
  evidence.scenarios.push('1440, 1024 and 390 widths with all layouts, readable panning and paired-details overlays; reduced motion.');
  await page.setViewportSize({width:1440,height:1000});await closeInspector();
  // Delay the actual worker asset, cancel the owned worker, then release the stale request.
  let held,markHeld;const workerHeld=new Promise(resolve=>markHeld=resolve);await page.route('**/*comparison-worker*.js',route=>new Promise(resolve=>{held=async()=>{await route.continue().catch(()=>{});resolve();};markHeld();}));
  await page.getByRole('button',{name:'Comparison rules',exact:true}).click();await page.getByRole('button',{name:'Apply rules and recompute',exact:true}).click();
  await workerHeld;await page.getByRole('dialog',{name:'Comparison rules',exact:true}).getByRole('button',{name:'Cancel computation',exact:true}).click();await held();await page.unroute('**/*comparison-worker*.js');
  await page.getByRole('button',{name:'Close comparison rules',exact:true}).click();await expect(page.locator('.comparison-notice')).toContainText('cancelled');
  await assertExport('file-after-cancel',resolved.output);evidence.scenarios.push('Real worker cancellation retains last valid result and terminates delayed worker startup.');
  await page.getByRole('button',{name:'Comparison rules',exact:true}).click();await page.getByRole('checkbox',{name:'Compare completed duration values',exact:true}).check();await page.getByRole('button',{name:'Apply rules and recompute',exact:true}).click();await expect(page.getByRole('dialog',{name:'Comparison rules',exact:true})).toHaveCount(0);const ruled=await assertExport('file-rules');assert.equal(ruled.output.profile.compare_timing,true);assert.deepEqual(ruled.output.profile.matches,resolved.output.profile.matches);evidence.scenarios.push('Rules apply through engine profile, preserve explicit matches, and regenerate reproducible exports; Copy finding clipboard citations verified.');
  await page.getByRole('button',{name:'Exit comparison',exact:true}).click();await expect(page.getByRole('button',{name:'Compare with…',exact:true})).toBeVisible();

  for(const [name,path,result] of [['equal','/same','Equal within scope'],['inconclusive','/unknown','Inconclusive']]){
    const a=comparisonFixture([path],'primary'),b=comparisonFixture([path],'secondary');
    await page.goto(origin);await page.getByLabel('Choose NDJSON files',{exact:true}).setInputFiles({name:name+'.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(ndjsonOf(a)+ndjsonOf(b))});
    await page.locator('.import-session').first().getByRole('button',{name:'Open',exact:true}).click();await page.getByRole('button',{name:'Compare with…',exact:true}).click();
    await page.locator('.comparison-session-option').filter({hasText:'comparison/development / secondary'}).click();await expect(page.getByLabel('Comparison summary')).toContainText(result);
    await assertExport('file-'+name,diffSequences(a,b));await page.getByRole('button',{name:'Exit comparison',exact:true}).click();
  }
  evidence.scenarios.push('Equal-within-scope and inconclusive unknown-only states separately exercised using complete canonical snapshots.');

  collector=await startCollector({directory:join(privateDir,'collector'),port:0,activate:false});
  const source=await collector.enroll({version:2,registration_id:randomUUID(),platform:'android',environment_id:'primary-source',app_id:'dev.comparison.fixture',installation_id:randomUUID()});
  const otherSource=await collector.enroll({version:2,registration_id:randomUUID(),platform:'android',environment_id:'secondary-source',app_id:'dev.comparison.fixture',installation_id:randomUUID()});
  await collector.ingest(otherSource.source_token,ndjsonOf(secondary));
  await collector.ingest(source.source_token,primary.events.slice(0,8).map(JSON.stringify).join('\n')+'\n');
  await page.goto(collector.origin);await expect(page.locator('.live-actions strong')).toContainText('● Live');
  await expect(page.getByRole('heading',{name:'Comparison workflow',exact:true})).toBeVisible();
  await page.locator('.source-navigation > details').filter({hasText:'primary-source'}).getByRole('button').click();
  await expect(page.locator('.live-actions strong')).toContainText('8 events');
  await page.getByRole('button',{name:'Compare with…',exact:true}).click();await page.locator('.comparison-session-option').filter({hasText:'comparison/development / secondary'}).click();
  await expect(page.getByLabel('Comparison summary')).toContainText('with uncertainty');
  const liveBefore=await assertExport('live-before',diffSequences({...primary,events:primary.events.slice(0,8)},secondary));assert.equal(liveBefore.snapshots.primary.events.length,8);assert.equal(liveBefore.snapshots.secondary.events.length,secondary.events.length);await expect(page.locator('.comparison-identity.primary')).toContainText('source-limited');
  await collector.ingest(source.source_token,primary.events.slice(8).map(JSON.stringify).join('\n')+'\n');
  await expect(page.locator('.comparison-live')).toContainText('new relevant events available',{timeout:10000});
  await assertExport('live-still-frozen',liveBefore.output);
  await page.route('**/api/v2/events?**',route=>route.abort('failed'));
  await page.getByRole('button',{name:'Recompute snapshots',exact:true}).click();await expect(page.getByRole('alert')).toContainText('last valid result is retained');
  await page.unroute('**/api/v2/events?**');await assertExport('live-after-failed-recompute',liveBefore.output);
  await page.getByRole('button',{name:'Recompute snapshots',exact:true}).click();await expect(page.locator('.comparison-identity.primary')).toContainText(`${primary.events.length} events`);await expect(page.getByLabel('Comparison summary')).toContainText('Different with uncertainty');
  await assertExport('live-recomputed',expected);await screenshot('live-recomputed');
  await page.getByRole('button',{name:'Pause comparison reads',exact:true}).click();await expect(page.getByRole('button',{name:'Resume comparison reads',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Resume comparison reads',exact:true}).click();
  const oldOrigin=collector.origin,oldPort=Number(new URL(oldOrigin).port);await collector.close();
  collector=await startCollector({directory:join(privateDir,'replacement-collector'),port:oldPort,activate:false});
  await expect(page.locator('.comparison-live')).toContainText('Collector reset',{timeout:15000});
  await expect(page.getByRole('button',{name:'Recompute snapshots',exact:true})).toBeDisabled();await assertExport('live-after-collector-reset',expected);
  await page.getByRole('button',{name:'Exit comparison',exact:true}).click();
  await expect(page.getByLabel('Follow newest session',{exact:true})).not.toBeChecked();
  evidence.scenarios.push('Real source-limited primary and secondary retained session on another source absent from displayed capture; unscoped picker, append detection with stable export, failed-read recomputation retains previous diff, explicit successful recompute, pause/resume and follow semantics, actual collector restart/reconnect retains export and reports changed identity.');
  assert.deepEqual(evidence.errors,[]);evidence.passed=true;
}catch(error){evidence.passed=false;evidence.error=error.stack;throw error;}
finally{
  await browser?.close();await collector?.close();
  if(server)await new Promise(resolve=>{server.httpServer.close(resolve);server.httpServer.closeAllConnections();});
  await rm(privateDir,{recursive:true,force:true});await writeFile(join(artifacts,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}
