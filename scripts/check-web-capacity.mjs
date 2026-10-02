// Storage-only capacity gate: minimal canonical lines, explicit grouped flushes, no collector/schema claim.
import {chromium} from '@playwright/test';
import http from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {cpus,totalmem} from 'node:os';
import assert from 'node:assert/strict';
let browser;
const server=http.createServer(async(req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Journal capacity gate</title>');return;}
  if(req.url==='/storage.mjs'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile('web-sdk/src/storage.mjs'));return;}
  res.writeHead(404);res.end();
});
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:process.env.WEB_TEST_CHANNEL||'chrome',headless:true});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(async()=>{
    const {IndexedDBJournal}=await import('/storage.mjs');
    const options={databaseName:'capacity-v2',journalId:'million',maxEvents:1000000,maxBytes:96*1024*1024};
    let journal=await IndexedDBJournal.open(options);const start=performance.now();let queueHighWater=0;
    for(let base=0;base<1000000;base+=500){for(let i=base;i<base+500;i++){if(!journal.append(JSON.stringify({event_id:'capacity-'+i})+'\n'))throw new Error('Capacity append rejected');}queueHighWater=Math.max(queueHighWater,journal.stats.pending);await journal.flush();}
    const appendMs=performance.now()-start,stats=journal.stats;await journal.close();const openStart=performance.now();journal=await IndexedDBJournal.open(options);const reopenMs=performance.now()-openStart;
    if(journal._lines.length!==0)throw new Error('Full history hydrated on reopen');
    const readStart=performance.now(),page=await journal.readPage(999900),rangeMs=performance.now()-readStart;
    const result={events:stats.events,bytes:stats.bytes,queueHighWater,appendMs,reopenMs,rangeMs,rangeEvents:page.lines.length,cursor:page.next,hydratedLines:journal._lines.length,dropped:stats.dropped};await journal.close();return result;
  });
  assert.equal(result.events,1000000);assert.equal(result.rangeEvents,100);assert.equal(result.cursor,1000000);assert.equal(result.hydratedLines,0);assert.equal(result.dropped,0);assert.ok(result.queueHighWater<=500);
  const evidence={...result,browser:await browser.version(),date:new Date().toISOString(),machine:{cpu:cpus()[0].model,totalMemoryBytes:totalmem()},scope:'Browser IndexedDB storage only; minimal event_id lines, grouped admission. This does not establish capture schema, collector million-event throughput, mobile behavior or power-loss durability.'};
  await mkdir('artifacts/web-browser',{recursive:true});await writeFile(resolve('artifacts/web-browser/capacity-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log('PASS browser journal capacity',JSON.stringify(evidence));
}finally{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});}
