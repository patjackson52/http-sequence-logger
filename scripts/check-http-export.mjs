// Production browser acceptance: real source provenance, selected request text, clipboard and downloads.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startCollector } from '../collector/server.mjs';
import { createServerLogger } from '../server-sdk/index.mjs';
import { buildViewer } from '../collector/runtime.mjs';

const directory=await mkdtemp(join(tmpdir(),'http-export-'));
const artifacts=resolve('artifacts/http-export');await mkdir(artifacts,{recursive:true});
const ndjson=events=>events.map(JSON.stringify).join('\n')+'\n';
let collector,browser;
try {
  const client=(await readFile(new URL('../examples/viewer-three-origin.ndjson',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
  const capturedBody=client.find(e=>e.event_type==='http.body.captured'&&e.data.direction==='request').data.body;
  const payload=''+JSON.stringify({name:'Jane Doe',email:'jane@example.com'});Object.assign(capturedBody,{availability:'captured',media_type:'application/json',charset:'utf-8',observed_bytes:Buffer.byteLength(payload),total_bytes:Buffer.byteLength(payload),stored_bytes:Buffer.byteLength(payload),reason:null,content:{encoding:'utf-8',data:payload}});
  const firstRequest=client.find(e=>e.event_type==='http.request.started');
  firstRequest.data.request.url='https://api.example:8443/sdk/0?tag=first&tag=second';
  firstRequest.data.request.headers.entries.push({name:'X-Visible-Request',value:'request-header-value',redacted:false});
  const firstResponse=client.find(e=>e.event_type==='http.response.headers');
  firstResponse.data.response.url='https://response.example:9443/result?complete=true';
  firstResponse.data.response.headers.entries.push({name:'Set-Cookie',value:'session=visible-fixture',redacted:false},{name:'X-Repeat',value:'one',redacted:false},{name:'X-Repeat',value:'two',redacted:false});
  const responseBody=client.find(e=>e.event_type==='http.body.captured'&&e.data.direction==='response').data.body;
  const responsePayload=JSON.stringify({verified:true,payload:'response-'+ 'x'.repeat(1000)+'-complete'});
  Object.assign(responseBody,{observed_bytes:Buffer.byteLength(responsePayload),total_bytes:Buffer.byteLength(responsePayload),stored_bytes:Buffer.byteLength(responsePayload),content:{encoding:'utf-8',data:responsePayload}});
  const endIndex=client.findIndex(e=>e.event_type==='http.ended');
  client.splice(endIndex,0,{...client[endIndex],event_id:'http-export-metrics',event_type:'http.metrics',data:{source:'browser-fixture',protocol_version:'h2',remote_address:'192.0.2.8',remote_port:8443,connection_reused:false,response_source:'network',transaction:null,phases:[]}});
  client.forEach((event,index)=>event.sequence=index+1);
  const other=JSON.parse(JSON.stringify(client));
  for(const e of other){e.event_id='other:'+e.event_id;e.recording_id='other:'+e.recording_id; if(e.context){for(const key of ['trace_id','span_id','parent_span_id'])if(e.context[key])e.context[key]=e.context[key].split('').map(ch=>((parseInt(ch,16)+1)%16).toString(16)).join('');}}
  const original=client.find(e=>e.event_type==='http.request.started'),serverEvents=[];
  const backend=createServerLogger({service:'Orders backend',sessionNamespace:'server/orders',emit:e=>serverEvents.push(e),fetch:async()=>new Response('ok')});
  for(let i=0;i<2;i++)await backend.handleRequest(new Request('https://orders.test/start',{headers:{traceparent:`00-${original.context.trace_id}-${original.context.span_id}-01`}}),async ctx=>{await ctx.fetch(`https://storage.test/write-${i}`);return new Response('ok');});
  await buildViewer();
  collector=await startCollector({directory:join(directory,'collector'),port:0,activate:false});
  async function enroll(environment,platform='android') {return collector.enroll({version:2,registration_id:randomUUID(),platform,environment_id:environment,environment_name:environment,app_id:client[0].data.producer.app_id,installation_id:randomUUID()});}
  const first=await enroll('Device One'),second=await enroll('Device Two'),server=await enroll('Development backend','server');
  await collector.ingest(first.source_token,ndjson(client));await collector.ingest(second.source_token,ndjson(other));await collector.ingest(server.source_token,ndjson(serverEvents));
  browser=await chromium.launch({channel:process.env.WEB_TEST_CHANNEL||'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],downloads=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(collector.origin);await expect(page.locator('.view-controls')).toContainText('18 of 18 requests');
  // A diagram filter must never remove requests from the selected source export.
  await page.getByRole('searchbox',{name:'Search paths and component names',exact:true}).fill('does-not-match');
  await page.getByRole('button',{name:'HTTP requests',exact:true}).click();
  const picker=page.getByLabel('Request source',{exact:true}),preview=page.getByLabel('HTTP request file',{exact:true});
  await expect(picker).toBeVisible();assert.equal(await picker.locator('option').count(),4);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:collector.origin});
  const copyButton=page.getByRole('button',{name:'Copy HTTP',exact:true});
  async function copy(keyboard=false){const text=await preview.textContent();if(keyboard){await copyButton.focus();await copyButton.press('Enter');}else await copyButton.click();await expect(copyButton).toHaveText('Copied');assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),text);}
  await copy(true);await expect(copyButton).toHaveText('Copy');
  const choices=await picker.locator('option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,text:n.textContent})));
  assert.equal(await picker.inputValue(),'');
  assert.equal(((await preview.textContent()).match(/^### Source:/gm)||[]).length,3);
  assert.equal(choices.filter(c=>c.text.includes('App + SDK')).length,2);assert.equal(choices.filter(c=>c.text.includes('Orders backend')).length,1);
  async function download(extension,name){const text=await preview.textContent(),pending=page.waitForEvent('download');await page.getByRole('button',{name:`Download .${extension}`,exact:true}).click();const file=await pending;assert.ok(file.suggestedFilename().endsWith('.'+extension));const path=join(artifacts,name+'.'+extension);await file.saveAs(path);assert.equal(await readFile(path,'utf8'),text);downloads.push(file.suggestedFilename());assert.doesNotMatch(text, /# (?:Evidence|Observation|Recording|Producer|Capture|Trace|Session|Selected source)|event_id|recording_id/);assert.match(text, /^(?:### Source: |POST |GET |# Request not captured|# Request cannot)/);return text;}
  for(const choice of choices.filter(choice=>choice.value)){await picker.selectOption(choice.value);const text=await download('http',choice.text.includes('Device Two')?'device-two':choice.text.includes('Orders backend')?'backend':'device-one');assert.equal((text.match(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) https?:/gm)||[]).length,choice.text.includes('Orders backend')?2:8);}
  const backendChoice=choices.find(c=>c.text.includes('Orders backend'));await picker.selectOption(backendChoice.value);await expect(copyButton).toHaveText('Copy');await copy();await page.getByRole('button',{name:'Sequence',exact:true}).click();await page.getByRole('button',{name:'HTTP requests',exact:true}).click();assert.equal(await picker.inputValue(),backendChoice.value);
  await page.locator('.toolbar').getByRole('button',{name:'Compare with…',exact:true}).click();await page.getByRole('dialog',{name:'Choose secondary session',exact:true}).getByRole('button',{name:'Close',exact:true}).click();assert.equal(await picker.inputValue(),backendChoice.value);
  const firstChoice=choices.find(c=>c.text.includes('Device One'));await picker.selectOption(firstChoice.value);
  const http=await download('http','same-source'),rest=await download('rest','same-source');assert.equal(http,rest);assert.ok(http.includes('\n{\n  "name": "Jane Doe",\n  "email": "jane@example.com"\n}'));for(const value of ['POST https://api.example:8443/sdk/0?tag=first&tag=second HTTP/2','Set-Cookie: session=visible-fixture','X-Repeat: one','X-Repeat: two','response-'+ 'x'.repeat(1000)+'-complete','request-header-value'])assert.ok(http.includes(value),value);assert.doesNotMatch(http, /Request port:|Response port:|Transport metrics:|Completion:|remote_port|protocol_version|stored_bytes/);assert.equal(await page.getByText('All recorded HTTP data',{exact:true}).count(),0);await expect(page.locator('.http-request-help')).toHaveCount(0);assert.doesNotMatch(await page.locator('.http-requests').innerText(), /Session:|recording\(s\)|diagram filters|environment unavailable/);
  await preview.evaluate(node=>{node.scrollTop=150;window.__requestPreview=node;});const scroll=await preview.evaluate(n=>n.scrollTop);
  await collector.ingest(first.source_token,ndjson(client));
  await page.waitForTimeout(1200);assert.equal(await picker.inputValue(),firstChoice.value);assert.equal(await preview.evaluate(n=>n===window.__requestPreview),true);assert.equal(await preview.evaluate(n=>n.scrollTop),scroll);
  // More events from the same source update text without resetting its identity or scroll.
  const extra=JSON.parse(JSON.stringify(client));for(const e of extra){e.event_id='extra:'+e.event_id;e.recording_id='extra:'+e.recording_id;if(e.context)for(const key of ['trace_id','span_id','parent_span_id'])if(e.context[key])e.context[key]=e.context[key].split('').map(ch=>((parseInt(ch,16)+2)%16).toString(16)).join('');}
  await collector.ingest(first.source_token,ndjson(extra));await expect(page.locator('.http-request-scope')).toContainText('16 requests');assert.equal(await picker.inputValue(),firstChoice.value);assert.equal(await preview.evaluate(n=>n.scrollTop),scroll);
  const pausedText=await preview.textContent();await page.getByRole('button',{name:'Pause live',exact:true}).click();assert.equal(await picker.inputValue(),firstChoice.value);assert.equal(await preview.textContent(),pausedText);await download('http','paused');
  await preview.evaluate(node=>{node.scrollTop=0;node.scrollLeft=0;});await page.screenshot({path:join(artifacts,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(picker).toBeVisible();await picker.focus();await picker.press('ArrowDown');await expect(picker).toBeFocused();await preview.focus();await preview.press('PageDown');await expect(preview).toBeFocused();await expect(page.getByRole('button',{name:'Download .rest',exact:true})).toBeVisible();await copy();await download('rest','mobile');await preview.evaluate(node=>{node.scrollTop=0;node.scrollLeft=0;});await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  // Importing canonical data clears live identity and keeps capture text inert.
  await page.setViewportSize({width:1440,height:1000});
  const hostile=JSON.parse(JSON.stringify(client));hostile[0].data.name='<img src=x onerror=alert(1)>';const hostileBody=hostile.find(e=>e.event_type==='http.body.captured'&&e.data.direction==='request');hostileBody.data.body={...hostileBody.data.body,availability:'captured',stored_bytes:Buffer.byteLength('<img src=x onerror=alert(1)>'),observed_bytes:Buffer.byteLength('<img src=x onerror=alert(1)>'),total_bytes:Buffer.byteLength('<img src=x onerror=alert(1)>'),reason:null,content:{encoding:'utf-8',data:'<img src=x onerror=alert(1)>'}};
  await page.getByLabel('Choose NDJSON files',{exact:true}).setInputFiles({name:'inert.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(ndjson(hostile))});
  await page.locator('.import-session').first().getByRole('button',{name:'Open',exact:true}).click();await page.getByRole('button',{name:'HTTP requests',exact:true}).click();
  await expect(preview).toContainText('<img src=x onerror=alert(1)>');assert.equal(await preview.locator('img').count(),0);assert.equal(await picker.count(),0);await download('http','imported');
  // A capture missing request starts must still expose its recorded responses and bodies.
  const responseOnly=client.filter(event=>event.event_type!=='http.request.started');
  await page.getByLabel('Choose NDJSON files',{exact:true}).setInputFiles({name:'response-only.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(ndjson(responseOnly))});
  await page.locator('.import-session').first().getByRole('button',{name:'Open',exact:true}).click();
  await expect(preview).toContainText('# Request not captured');await expect(preview).toContainText('HTTP/2 200');
  await expect(page.getByRole('button',{name:'Download .http',exact:true})).toBeEnabled();
  const orphan=await download('http','response-only');assert.equal((orphan.match(/^(?:GET|POST) https?:/gm)||[]).length,0);
  await page.evaluate(()=>{window.__clipboardWrite=navigator.clipboard.writeText;navigator.clipboard.writeText=async()=>{throw new Error('denied');};});
  await copyButton.click();await expect(page.getByRole('alert')).toContainText('Copy unavailable');await expect(copyButton).toHaveText('Copy');
  await page.evaluate(()=>{navigator.clipboard.writeText=undefined;});
  await copyButton.click();await expect(page.getByRole('alert')).toContainText('Copy unavailable');await expect(copyButton).toHaveText('Copy');
  await page.evaluate(()=>{navigator.clipboard.writeText=window.__clipboardWrite;delete window.__clipboardWrite;});
  await copy();await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Choose NDJSON files',{exact:true}).setInputFiles(resolve('examples/handler-no-http.ndjson'));
  await page.locator('.import-session').first().getByRole('button',{name:'Open',exact:true}).click();
  await expect(page.getByText('No HTTP requests captured',{exact:true})).toBeVisible();
  await expect(copyButton).toBeDisabled();await expect(copyButton).toHaveText('Copy');await expect(page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(errors,[]);await writeFile(join(artifacts,'evidence.json'),JSON.stringify({passed:true,browser:browser.version(),sources:choices,downloads,clipboardMatchesTranscript:true,clipboardKeyboardAndReset:true,clipboardDisabledWithoutHTTP:true,clipboardUnavailableAndRetry:true,clipboardFailureAndRetry:true,previewEqualsDownloads:true,requestAndResponseFormat:true,explicitPorts:true,completePayloads:true,compactTranscript:true,allSourcesSections:true,prettyJSON:true,sameAppDevicesDistinct:true,appAndSDKCombined:true,backendRecordingsCombined:true,diagramFiltersIgnored:true,viewAndComparisonSelectionPreserved:true,pauseSelectionPreserved:true,newEventsPreserveScroll:true,mobile:true,inertImportedText:true,errors},null,2)+'\n');
  console.log('HTTP request source selection, clipboard, production downloads and mobile acceptance passed.');
}finally{await browser?.close();await collector?.close();await rm(directory,{recursive:true,force:true});}
