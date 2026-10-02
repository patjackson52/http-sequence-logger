// Authenticated reachable-frontend fixture. Certificates/session secrets stay in a private temporary directory.
import {chromium,firefox,webkit} from '@playwright/test';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {startCollector} from '../collector/server.mjs';
import {createNetworkLogRelay} from '../web-sdk/dev-relay.mjs';
const directory=await mkdtemp(join(tmpdir(),'web-https-v2-'));
const engine=process.env.WEB_TEST_ENGINE||'chromium';
let collector,frontend,browser;
try{
  const key=join(directory,'frontend.key'),cert=join(directory,'frontend.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
  collector=await startCollector({directory:join(directory,'collector'),port:0});
  const ticket=await collector.store.ticket({principal:'https-web-check'}),manifest=join(directory,'active.json');
  await writeFile(manifest,JSON.stringify({version:2,collector_id:collector.store.config.collector_id,endpoint:collector.origin,enrollment_token:ticket.enrollment_token}),{mode:0o600});
  const cookieA=randomBytes(32).toString('hex'),cookieB=randomBytes(32).toString('hex');
  const authorize=req=>{const cookie=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('development_session='))?.slice('development_session='.length);return cookie===cookieA?'session-a':cookie===cookieB?'session-b':null;};
  let relay;
  frontend=https.createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
    if(!authorize(req)){res.writeHead(401);res.end('Authenticated development session required');return;}
    relay(req,res,async()=>{
      if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Authenticated debug frontend</title><body>Ready</body>');return;}
      if(/^\/web-sdk\/src\/[a-z-]+\.mjs$/.test(req.url)){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(resolve('.'+req.url)));return;}
      res.writeHead(404);res.end();
    });
  });
  await new Promise(r=>frontend.listen(0,'127.0.0.1',r));
  const origin=`https://127.0.0.1:${frontend.address().port}`;
  relay=createNetworkLogRelay({origin,connectionFile:manifest,reachable:true,authorize});
  browser=await {chromium,firefox,webkit}[engine].launch({headless:true,...(engine==='chromium'?{channel:process.env.WEB_TEST_CHANNEL||'chrome'}:{})});
  const guest=await browser.newContext({ignoreHTTPSErrors:true});
  const denied=await guest.request.post(origin+'/__network_log/register',{headers:{Origin:origin},data:{}});assert.equal(denied.status(),401);
  const context=await browser.newContext({ignoreHTTPSErrors:true});
  await context.addCookies([{name:'development_session',value:cookieA,url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  const result=await page.evaluate(async()=>{
    const {IndexedDBJournal,createLogger,uploadJournal}=await import('/web-sdk/src/index.mjs');
    const journal=await IndexedDBJournal.open({databaseName:'authenticated-browser-v2',journalId:crypto.randomUUID()});
    const logger=createLogger({namespace:'authenticated.browser',appId:'authenticated-web-app',sink:journal});
    const session=logger.startSession({name:'Authenticated HTTPS browser'});session.end();await journal.flush();
    const delivered=await uploadJournal(journal,{appId:'authenticated-web-app'});const exported=await journal.exportNDJSON();
    const config=await(await fetch('/__network_log/register',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...journal.identity,version:2,platform:'web',app_id:'authenticated-web-app',environment_name:'Browser',origin:location.origin,registration_id:journal.identity.journal_id})})).json();
    await journal.close();return {...delivered,exported,handle:config.handle};
  });
  assert.equal(result.events,2);assert.equal(collector.store.cursor,2);assert.equal((await collector.store.sources()).sources.length,1);
  assert.equal(result.exported.includes(cookieA),false);assert.equal(JSON.stringify(result).includes(ticket.enrollment_token),false);
  const other=await browser.newContext({ignoreHTTPSErrors:true});await other.addCookies([{name:'development_session',value:cookieB,url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);
  const crossed=await other.request.post(origin+'/__network_log/events',{headers:{Origin:origin,'Content-Type':'application/x-ndjson','X-Network-Log-Handle':result.handle},data:result.exported});assert.equal(crossed.status(),403);assert.equal(collector.store.cursor,2);
  assert.deepEqual(errors,[]);
  const artifact=resolve('artifacts/web-browser');await mkdir(artifact,{recursive:true});await writeFile(join(artifact,`https-${engine}-evidence.json`),JSON.stringify({engine,browser:await browser.version(),date:new Date().toISOString(),events:2,checks:['HTTPS frontend with authenticated secure HttpOnly session','unauthenticated valid-origin request rejected','same-origin IndexedDB upload','cross-session journal handle rejected','no source/enrollment/session credentials in capture']},null,2)+'\n');
  console.log(`PASS ${engine} ${await browser.version()}: authenticated HTTPS frontend, 2 events, guest/session isolation`);
}finally{await browser?.close();if(frontend)await new Promise(r=>{frontend.close(r);frontend.closeAllConnections();});await collector?.close();await rm(directory,{recursive:true,force:true});}
