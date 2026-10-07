import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startCollector } from '../collector/server.mjs';
import { createLocalFileAdapter } from '../collector/adapters.mjs';
import { createServerLogger } from '../server-sdk/index.mjs';
import { buildViewer } from '../collector/runtime.mjs';

const directory=await mkdtemp(join(tmpdir(),'viewer-distributed-'));
const artifacts=resolve('artifacts/viewer-distributed');await mkdir(artifacts,{recursive:true});
let collector,browser;
try {
  const client=(await readFile(new URL('../examples/viewer-three-origin.ndjson',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
  const request=client.find(e=>e.event_type==='http.request.started');
  const parent=`00-${request.context.trace_id}-${request.context.span_id}-01`,lines=[];
  const b=createServerLogger({service:'Server B',sessionNamespace:'server/b',emit:e=>lines.push(JSON.stringify(e))});
  const c=createServerLogger({service:'Server C',sessionNamespace:'server/c',emit:e=>lines.push(JSON.stringify(e))});
  const a=createServerLogger({service:'Server A',sessionNamespace:'server/a',emit:e=>lines.push(JSON.stringify(e)),propagationOrigins:['https://b.test','https://c.test'],fetch:r=>(new URL(r.url).host==='b.test'?b:c).handleRequest(r,async ctx=>{ctx.log('received downstream request');return new Response('ok');})});
  await a.handleRequest(new Request('https://a.test/start',{headers:{traceparent:parent}}),async ctx=>{await Promise.all([ctx.fetch('https://b.test/work'),ctx.fetch('https://c.test/work')]);ctx.log('downstream calls finished');return new Response('ok');});
  const path=join(directory,'server.ndjson');await writeFile(path,lines.join('\n')+'\n');
  await buildViewer();
  collector=await startCollector({directory:join(directory,'collector'),port:0,activate:false,sources:[createLocalFileAdapter({id:'local-dev',path,metadata:{environment_id:'local-dev',app_id:'server.logs',installation_id:'dev'}})]});
  const source=await collector.enroll({version:2,registration_id:randomUUID(),platform:client[0].data.producer.platform,environment_id:'browser-test',app_id:client[0].data.producer.app_id,installation_id:randomUUID()});
  browser=await chromium.launch({channel:process.env.WEB_TEST_CHANNEL || 'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(collector.origin);await expect(page.locator('.live-actions strong')).toContainText('● Live');
  await collector.ingest(source.source_token,client.map(JSON.stringify).join('\n')+'\n');
  await expect(page.locator('.view-controls')).toContainText('8 of 8 requests');
  await expect(page.getByLabel('Follow newest session')).toBeChecked();
  await page.getByRole('button',{name:'Refresh related logs',exact:true}).click();
  await expect(page.locator('.collection-status')).toHaveText('Updated');
  await expect(page.locator('.view-controls')).toContainText('10 of 10 requests');
  for(const service of ['Server A','Server B','Server C'])await expect(page.getByLabel(`${service} · recorded server activity`,{exact:true})).toBeVisible();
  const linked=page.locator('.nll-seq-arrow-label').filter({hasText:'Causal link · clocks independent'});assert.equal(await linked.count(),3);
  const id=`${request.context.trace_id}/${request.context.span_id}`;
  await page.locator(`.nll-seq-svg [data-entity-id="${id}"]`).first().click();
  await expect(page.getByRole('region',{name:'Details inspector'})).toBeVisible();
  await page.getByRole('tab',{name:'Attribution',exact:true}).click();
  await page.evaluate(()=>{const host=document.querySelector('.diagram-host');host.scrollTop=250;host.scrollLeft=90;window.__stableSVG=document.querySelector('.nll-seq-svg');});
  const before=await page.evaluate(()=>({scroll:[document.querySelector('.diagram-host').scrollTop,document.querySelector('.diagram-host').scrollLeft],html:document.querySelector('.nll-seq-svg').outerHTML,selected:document.querySelector('.inspector h2').textContent,tab:document.querySelector('[role=tab][aria-selected=true]').textContent}));
  // Identical collection and replay trigger source/status notifications without new data.
  for(let i=0;i<3;i++){
    await page.getByRole('button',{name:'Refresh related logs',exact:true}).click();await expect(page.locator('.collection-status')).toHaveText('No new logs');
    await collector.ingest(source.source_token,client.map(JSON.stringify).join('\n')+'\n');
  }
  await page.waitForTimeout(300);
  const after=await page.evaluate(()=>({scroll:[document.querySelector('.diagram-host').scrollTop,document.querySelector('.diagram-host').scrollLeft],html:document.querySelector('.nll-seq-svg').outerHTML,selected:document.querySelector('.inspector h2').textContent,tab:document.querySelector('[role=tab][aria-selected=true]').textContent}));
  assert.deepEqual(after,before);assert.equal(await page.evaluate(()=>window.__stableSVG===document.querySelector('.nll-seq-svg')),true);assert.deepEqual(errors,[]);
  await page.screenshot({path:join(artifacts,'viewer.png'),fullPage:true});
  await writeFile(join(artifacts,'evidence.json'),JSON.stringify({passed:true,browser:browser.version(),client_requests:8,server_requests:2,remote_links:3,identical_refreshes:3,default_follow_newest:true,stable_selection:true,stable_tab:true,stable_scroll:true,stable_svg_node:true,errors},null,2)+'\n');
  console.log('Distributed viewer refresh and unchanged-data stability passed.');
} finally {await browser?.close();await collector?.close();await rm(directory,{recursive:true,force:true});}
