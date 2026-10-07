import { createComparisonSnapshot, SNAPSHOT_LIMITS } from './comparison-data.mjs';

// Source registry and session summaries are independent of selected-session capture pages.
export class CollectorClient {
  constructor({token,automatic=false,fetcher=(...args)=>fetch(...args),onCapture=()=>{},onStatus=()=>{},onPairing=()=>{},onDevice=()=>{},onReset=()=>{},onSources=()=>{},onSessions=()=>{},onRevision=()=>{},onCollection=()=>{},retryMs=1000}) {
    Object.assign(this,{token,automatic,fetcher,onCapture,onStatus,onPairing,onDevice,onReset,onSources,onSessions,onRevision,onCollection,retryMs});
    this.cursor=0;this.lines=[];this.collectorId=null;this.generation=0;this.selection={};this.sessions=[];this.followLatest=true;this._work=Promise.resolve();
    this.snapshotGeneration=0;this.snapshotReads=new Set();
  }
  async request(path,signal,headers={},options={}) {
    const response=await this.fetcher(path,{...options,headers:{Authorization:`Bearer ${this.token}`,...headers},signal:path.includes('/stream')?signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),cache:'no-store',mode:'same-origin',redirect:'error'});
    signal?.throwIfAborted();
    if(!response.ok)throw new Error(`Collector returned HTTP ${response.status}`);
    return response;
  }
  async connect(signal) {
    if(!this.automatic)return;
    const response=await this.fetcher('/api/v2/bootstrap',{headers:{'X-Network-Log-Viewer':'1'},signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),cache:'no-store',mode:'same-origin',redirect:'error'});
    if(!response.ok)throw new Error('Waiting for the local collector…');
    const session=await response.json();signal.throwIfAborted();
    if(session.version!==2||typeof session.token!=='string'||typeof session.collector_id!=='string')throw new Error('Invalid collector bootstrap');
    if(this.collectorId&&this.collectorId!==session.collector_id){this._cancelSnapshotReads();this.cursor=0;this.lines=[];this.selection={};this.generation++;this.onReset();}
    this.collectorId=session.collector_id;this.token=session.token;
  }
  select(selection={}) {
    this.selection={...selection};this.generation++;this.selectionController?.abort();this.selectionController=new AbortController();this.cursor=0;this.lines=[];
    this._captureText='';this.onCapture('',0);this._schedule();this.cancelCollection().catch(()=>{});
  }
  _schedule() {
    this._requested=true;
    if(this._sync)return this._sync;
    this._sync=(async()=>{while(this._requested&&this.controller&&!this.controller.signal.aborted){this._requested=false;const generation=this.generation;try{await this.refresh(this.controller.signal);}catch(error){if(error.name!=='AbortError'&&generation===this.generation)throw error;}}})().finally(()=>{this._sync=null;});
    this._sync.catch(error=>this.onStatus({state:'error',count:this.lines.length,error:error.message}));
    return this._sync;
  }
  async refresh(signal) {
    const generation=this.generation;
    const status=await(await this.request('/api/v2/status',signal)).json();signal.throwIfAborted();
    if(generation!==this.generation)return;
    this._publish('device',status.adapters||{},this.onDevice);
    const sources=await(await this.request('/api/v2/sources',signal)).json();signal.throwIfAborted();
    if(!this.collectorId)this.collectorId=sources.collector_id;
    if(sources.collector_id!==this.collectorId)throw new Error('Collector changed; reconnecting…');
    if(generation!==this.generation)return;
    this._publish('sources',sources.sources||[],this.onSources);
    if(this._comparisonRevision!==sources.event_cursor){this._comparisonRevision=sources.event_cursor;this.onRevision({collector_id:this.collectorId,event_cursor:sources.event_cursor});}
    if(this._sessionGeneration===generation&&this._eventRevision===sources.event_cursor){this.onStatus({state:'live',count:this.lines.length});return;}
    const query=new URLSearchParams();if(this.selection.source_id)query.set('source_id',this.selection.source_id);
    const page=await(await this.request('/api/v2/sessions?'+query,signal)).json();signal.throwIfAborted();
    if(generation!==this.generation)return;
    this.sessionHighWater=page.high_water;this.sessions=page.sessions||[];this.nextSessions=page.has_more?page.next_after:null;this._publish('sessions',{sessions:this.sessions,next:this.nextSessions},v=>this.onSessions(v.sessions,v.next));
    let newest=this.sessions.at(-1);
    if(this.followLatest||!this.selection.session_id) {
      const latestQuery=new URLSearchParams(query);latestQuery.set('latest','true');latestQuery.set('limit','1');const selectedSource=(sources.sources||[]).find(s=>s.source_id===this.selection.source_id);const selectedSession=this.sessions.find(s=>s.session_namespace===this.selection.session_namespace&&s.session_id===this.selection.session_id);const selectedServer=selectedSource?.platform==='server'||(!this.selection.source_id&&selectedSession?.source_ids?.length&&selectedSession.source_ids.every(id=>(sources.sources||[]).find(s=>s.source_id===id)?.platform==='server'));if(!selectedServer)latestQuery.set('client_only','true');latestQuery.set('high_water',String(page.high_water));
      const latest=await(await this.request('/api/v2/sessions?'+latestQuery,signal)).json();signal.throwIfAborted();if(generation!==this.generation)return;newest=latest.sessions?.[0]||newest;
    }
    if(newest&&(!this.selection.session_id||this.followLatest)) {
      const next={...this.selection,session_namespace:newest.session_namespace,session_id:newest.session_id};
      if(next.session_id!==this.selection.session_id||next.session_namespace!==this.selection.session_namespace){this.selection=next;this.cursor=0;this.lines=[];}
    }
    if(this.selection.session_id)await this.catchUp(signal,generation);
    if(generation===this.generation){this._sessionGeneration=generation;this._eventRevision=sources.event_cursor;}
    if(generation===this.generation)this.onStatus({state:'live',count:this.lines.length});
  }
  pairing() {
    if(this._pairing)return this._pairing;
    this._pairing=this._createPairing().finally(()=>{this._pairing=null;});return this._pairing;
  }
  async _createPairing() {
    const signal=this.controller?.signal,generation=this.generation,collectorId=this.collectorId;
    const endpoints=await(await this.request('/api/v2/pairing',signal)).json();
    const grant=await(await this.request('/api/v2/admin/enrollment',signal,{'X-Network-Log-Viewer':'1','Content-Type':'application/json'},{method:'POST',body:JSON.stringify({principal:'native-pairing',max_sources:1})})).json();
    if(generation!==this.generation||collectorId!==this.collectorId)return;
    this.onPairing((endpoints.connections||[]).map(connection=>({...connection,enrollment_token:grant.enrollment_token,expires_at:grant.expires_at})));return true;
  }
  async moreSessions() {
    if(!this.nextSessions)return;
    const signal=this.controller.signal,generation=this.generation;
    const query=new URLSearchParams({after:String(this.nextSessions),high_water:String(this.sessionHighWater)});if(this.selection.source_id)query.set('source_id',this.selection.source_id);
    const page=await(await this.request('/api/v2/sessions?'+query,signal)).json();
    if(generation!==this.generation)return;
    this.sessions.push(...page.sessions);this.nextSessions=page.has_more?page.next_after:null;this._publish('sessions',{sessions:this.sessions,next:this.nextSessions},v=>this.onSessions(v.sessions,v.next));
  }
  async catchUp(signal,generation=this.generation) {
    const selectedSignal=this.selectionController?.signal;
    const combined=selectedSignal?AbortSignal.any([signal,selectedSignal]):signal;
    let highWater,cursor=0;const lines=[];
    for(;;){
      const query=new URLSearchParams({after:String(cursor),...this.selection,include_related:'true'});if(highWater!==undefined)query.set('high_water',String(highWater));
      const page=await(await this.request('/api/v2/events?'+query,combined)).json();combined.throwIfAborted();
      if(generation!==this.generation)return;
      if(page.collector_id!==this.collectorId||!Array.isArray(page.lines)||!Number.isSafeInteger(page.cursor)||page.cursor<cursor||(page.has_more&&page.cursor<=cursor))throw new Error('Invalid collector page');
      highWater??=page.high_water;
      if(lines.length+page.lines.length>100000)throw new Error('Selected session exceeds diagram limit; export capture to inspect it in smaller files');
      lines.push(...page.lines);cursor=page.cursor;
      if(!page.has_more){this.lines=lines;this.cursor=cursor;const text=this.lines.length?this.lines.join('\n')+'\n':'';if(text!==this._captureText){this._captureText=text;this.onCapture(text,this.lines.length);}return;}
    }
  }
  _publish(key,value,callback) {
    const text=JSON.stringify(value);this._published??={};
    if(this._published[key]===text)return;
    this._published[key]=text;callback(value);
  }
  async collectRelated() {
    if(this.collectionController)return;
    if(!this.selection.session_id)throw new Error('Select a session to collect related logs.');
    const controller=new AbortController(),generation=this.generation;
    this.collectionController=controller;this.collectionCancelRequested=false;
    this._publish('collection',{state:'queued'},this.onCollection);
    try {
      const response=await this.request('/api/v2/collections',controller.signal,{'X-Network-Log-Viewer':'1','Content-Type':'application/json'},{method:'POST',body:JSON.stringify(this.selection)});
      let job=await response.json();controller.signal.throwIfAborted();this.collectionJob=job.job_id;
      if(this.collectionCancelRequested||generation!==this.generation){await this.cancelCollection();return;}
      for (;;) {
        if(generation!==this.generation)return;
        this._publish('collection',job,this.onCollection);
        if(!['queued','running'].includes(job.state)) { await this._schedule();return job; }
        await new Promise((resolve,reject)=>{const timer=setTimeout(done,750);function done(){clearTimeout(timer);controller.signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(new DOMException('Collection stopped','AbortError'));}controller.signal.addEventListener('abort',abort,{once:true});});
        job=await(await this.request('/api/v2/collections/'+encodeURIComponent(this.collectionJob),controller.signal)).json();
      }
    } catch(error) { if(error.name!=='AbortError'&&generation===this.generation)this._publish('collection',{state:'failed',error:error.message},this.onCollection); }
    finally { if(this.collectionController===controller){this.collectionController=null;this.collectionJob=null;} }
  }
  async cancelCollection() {
    const controller=this.collectionController,job=this.collectionJob;
    if(!controller)return;
    this.collectionCancelRequested=true;
    this._publish('collection',{state:'cancelled'},this.onCollection);
    // Let an in-flight creation return its ID so cancellation cannot orphan the remote job.
    if(!job)return;
    controller.abort();this.collectionController=null;this.collectionJob=null;
    await this.request('/api/v2/collections/'+encodeURIComponent(job),undefined,{'X-Network-Log-Viewer':'1'},{method:'DELETE'});
  }
  _cancelSnapshotReads() {
    this.snapshotGeneration++;
    for(const controller of this.snapshotReads)controller.abort();
    this.snapshotReads.clear();
  }
  async _snapshotRead(operation,signal) {
    const controller=new AbortController(),generation=this.snapshotGeneration;
    this.snapshotReads.add(controller);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const check=()=>{combined.throwIfAborted();if(generation!==this.snapshotGeneration)throw new DOMException('Collector snapshot replaced.','AbortError');};
    try{return await operation(combined,check);}finally{this.snapshotReads.delete(controller);}
  }
  async _snapshotPages(selection,{signal,check,after=0,highWater,collectorId=this.collectorId,limits=SNAPSHOT_LIMITS}) {
    if(!selection.session_namespace||!selection.session_id)throw new Error('Select a session by namespace and session ID.');
    limits={...SNAPSHOT_LIMITS,...limits};
    let cursor=after,bytes=0,pages=0;
    const lines=[],events=[],sourceLines=Object.create(null);
    for(;;){
      check();if(++pages>limits.pages)throw new Error('Collector snapshot exceeds the bounded page-read limit; no partial snapshot was created.');
      const query=new URLSearchParams({...selection,after:String(cursor)});
      if(highWater!==undefined)query.set('high_water',String(highWater));
      const page=await(await this.request('/api/v2/events?'+query,signal)).json();check();
      if(collectorId&&page.collector_id!==collectorId){const error=new Error('Collector changed. Retained comparison snapshots still show the previous collector; acquire new snapshots to compare again.');error.name='CollectorResetError';throw error;}
      collectorId??=page.collector_id;
      if(typeof collectorId!=='string'||!Array.isArray(page.lines)||!Number.isSafeInteger(page.high_water)||page.high_water<cursor||!Number.isSafeInteger(page.cursor)||page.cursor<cursor||page.cursor>page.high_water||typeof page.has_more!=='boolean'||page.has_more&&page.cursor<=cursor||highWater!==undefined&&page.high_water!==highWater||!page.has_more&&page.cursor!==page.high_water)throw new Error('Invalid collector snapshot page.');
      highWater??=page.high_water;
      for(const line of page.lines){
        if(typeof line!=='string')throw new Error('Invalid collector snapshot line.');
        bytes+=new TextEncoder().encode(line).length+1;
        if(bytes>limits.bytes||events.length>=limits.events)throw new Error('Collector snapshot exceeds the comparison input limit; no partial snapshot was created.');
        let event;try{event=JSON.parse(line);}catch{throw new Error('Malformed collector snapshot event.');}
        if(event.session_namespace!==selection.session_namespace||event.session_id!==selection.session_id)throw new Error('Collector returned events outside the selected session.');
        events.push(event);lines.push(line);
        (sourceLines[event.event_id]??=[]).push({fileName:'Collector snapshot',fileId:collectorId,line:events.length,text:line});
      }
      cursor=page.cursor;if(!page.has_more)return {events,lines,sourceLines,collectorId,highWater};
    }
  }
  async snapshotSession(identity,{signal,highWater,limits=SNAPSHOT_LIMITS}={}) {
    const selection={session_namespace:identity.session_namespace??identity.namespace,session_id:identity.session_id??identity.sessionId??identity.id};
    if(identity.source_id)selection.source_id=identity.source_id;
    return this._snapshotRead(async(signal,check)=>{
      const result=await this._snapshotPages(selection,{signal,check,highWater,limits});check();
      if(!this.collectorId)this.collectorId=result.collectorId;
      return createComparisonSnapshot({...selection,events:result.events},{kind:'collector',sourceId:selection.source_id,collectorId:result.collectorId,highWater:result.highWater,sourceLines:result.sourceLines});
    },signal);
  }
  async comparisonSessions({signal,after=0,highWater}={}) {
    return this._snapshotRead(async(signal,check)=>{
      const collectorId=this.collectorId,query=new URLSearchParams({after:String(after),limit:'100'});
      if(highWater!==undefined)query.set('high_water',String(highWater));
      const page=await(await this.request('/api/v2/sessions?'+query,signal)).json();check();
      if(collectorId&&page.collector_id!==collectorId){const error=new Error('Collector changed; reload the comparison session catalog.');error.name='CollectorResetError';throw error;}
      if(typeof page.collector_id!=='string'||!Array.isArray(page.sessions)||!Number.isSafeInteger(page.high_water)||highWater!==undefined&&page.high_water!==highWater||!Number.isSafeInteger(page.next_after)||page.next_after<after||page.has_more&&page.next_after<=after||typeof page.has_more!=='boolean')throw new Error('Invalid comparison session catalog.');
      if(!this.collectorId)this.collectorId=page.collector_id;
      return page;
    },signal);
  }
  async comparisonUpdates(snapshots,{signal}={}) {
    return this._snapshotRead(async(signal,check)=>{
      const bySnapshot={},collectorSnapshots=snapshots.filter(snapshot=>snapshot.kind==='collector');
      if(!collectorSnapshots.length)return {changed:false,count:0,bySnapshot,collectorChanged:false};
      const state=await(await this.request('/api/v2/sources',signal)).json();check();
      if(collectorSnapshots.some(snapshot=>snapshot.boundary.collector_id!==state.collector_id))return {changed:true,count:0,bySnapshot,collectorChanged:true};
      if(!Number.isSafeInteger(state.event_cursor))throw new Error('Invalid collector revision.');
      for(const snapshot of collectorSnapshots){
        const after=snapshot.boundary.high_water;
        if(state.event_cursor<after)return {changed:true,count:0,bySnapshot,collectorChanged:true};
        if(state.event_cursor===after){bySnapshot[snapshot.id]=0;continue;}
        const selection={session_namespace:snapshot.document.session.namespace,session_id:snapshot.document.session.id};
        if(snapshot.scope.source_id)selection.source_id=snapshot.scope.source_id;
        const result=await this._snapshotPages(selection,{signal,check,after,highWater:state.event_cursor,collectorId:state.collector_id});
        bySnapshot[snapshot.id]=result.events.length;
      }
      const count=Object.values(bySnapshot).reduce((sum,value)=>sum+value,0);
      return {changed:count>0,count,bySnapshot,collectorChanged:false};
    },signal);
  }
  async run(){
    this.stop();const controller=new AbortController();this.controller=controller;const signal=controller.signal;
    this.onStatus({state:this.cursor?'reconnecting':'connecting',count:this.lines.length});
    while(!signal.aborted){
      try{
        await this.connect(signal);
        const response=await this.request('/api/v2/stream',signal);
        if(signal.aborted){response.body?.cancel().catch(()=>{});break;}
        const reader=response.body.getReader();
        this._reader=reader;
        try{
          await this._schedule();const decoder=new TextDecoder();let buffer='';
          while(!signal.aborted){const {value,done}=await reader.read();if(signal.aborted)break;if(done)throw new Error('Collector disconnected');buffer+=decoder.decode(value,{stream:true});if(buffer.length>65536)throw new Error('Notification exceeds limit');let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const message=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);if(/^event: (ready|changed)$/m.test(message))await this._schedule();}}
        }finally{if(this._reader===reader)this._reader=null;await reader.cancel().catch(()=>{});}
      }catch(error){if(signal.aborted)break;this.onStatus({state:'reconnecting',count:this.lines.length,error:error.message});await new Promise(resolve=>{const timer=setTimeout(done,this.retryMs);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});}
    }
  }
  stop(){
    this.cancelCollection().catch(()=>{});
    this._cancelSnapshotReads();
    const controller=this.controller,selectionController=this.selectionController,reader=this._reader;
    this.controller=null;this.selectionController=null;this._reader=null;this.generation++;
    controller?.abort();selectionController?.abort();
    // An idle SSE read can survive request abort; cancel its owned reader too.
    reader?.cancel().catch(()=>{});
  }
  async download(){return(await this.request('/api/v2/download')).blob();}
}
