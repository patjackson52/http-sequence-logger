// Source registry and session summaries are independent of selected-session capture pages.
export class CollectorClient {
  constructor({token,automatic=false,fetcher=(...args)=>fetch(...args),onCapture=()=>{},onStatus=()=>{},onPairing=()=>{},onDevice=()=>{},onReset=()=>{},onSources=()=>{},onSessions=()=>{},retryMs=1000}) {
    Object.assign(this,{token,automatic,fetcher,onCapture,onStatus,onPairing,onDevice,onReset,onSources,onSessions,retryMs});
    this.cursor=0;this.lines=[];this.collectorId=null;this.generation=0;this.selection={};this.sessions=[];this.followLatest=true;this._work=Promise.resolve();
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
    if(this.collectorId&&this.collectorId!==session.collector_id){this.cursor=0;this.lines=[];this.selection={};this.generation++;this.onReset();}
    this.collectorId=session.collector_id;this.token=session.token;
  }
  select(selection={}) {
    this.selection={...selection};this.generation++;this.selectionController?.abort();this.selectionController=new AbortController();this.cursor=0;this.lines=[];
    this.onCapture('',0);this._schedule();
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
    this.onDevice(status.adapters||{});
    const sources=await(await this.request('/api/v2/sources',signal)).json();signal.throwIfAborted();
    if(!this.collectorId)this.collectorId=sources.collector_id;
    if(sources.collector_id!==this.collectorId)throw new Error('Collector changed; reconnecting…');
    if(generation!==this.generation)return;
    this.onSources(sources.sources||[]);
    if(this._sessionGeneration===generation&&this._eventRevision===sources.event_cursor){this.onStatus({state:'live',count:this.lines.length});return;}
    const query=new URLSearchParams();if(this.selection.source_id)query.set('source_id',this.selection.source_id);
    const page=await(await this.request('/api/v2/sessions?'+query,signal)).json();signal.throwIfAborted();
    if(generation!==this.generation)return;
    this.sessionHighWater=page.high_water;this.sessions=page.sessions||[];this.nextSessions=page.has_more?page.next_after:null;this.onSessions(this.sessions,this.nextSessions);
    let newest=this.sessions.at(-1);
    if(this.followLatest||!this.selection.session_id) {
      const latestQuery=new URLSearchParams(query);latestQuery.set('latest','true');latestQuery.set('limit','1');latestQuery.set('high_water',String(page.high_water));
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
    this.sessions.push(...page.sessions);this.nextSessions=page.has_more?page.next_after:null;this.onSessions(this.sessions,this.nextSessions);
  }
  async catchUp(signal,generation=this.generation) {
    const selectedSignal=this.selectionController?.signal;
    const combined=selectedSignal?AbortSignal.any([signal,selectedSignal]):signal;
    let highWater;const initialLength=this.lines.length;
    for(;;){
      const query=new URLSearchParams({after:String(this.cursor),...this.selection});if(highWater!==undefined)query.set('high_water',String(highWater));
      const page=await(await this.request('/api/v2/events?'+query,combined)).json();combined.throwIfAborted();
      if(generation!==this.generation)return;
      if(page.collector_id!==this.collectorId||!Array.isArray(page.lines)||!Number.isSafeInteger(page.cursor)||page.cursor<this.cursor||(page.has_more&&page.cursor<=this.cursor))throw new Error('Invalid collector page');
      highWater??=page.high_water;
      if(this.lines.length+page.lines.length>100000)throw new Error('Selected session exceeds diagram limit; export capture to inspect it in smaller files');
      this.lines.push(...page.lines);this.cursor=page.cursor;
      if(!page.has_more){if(this.lines.length>initialLength)this.onCapture(this.lines.join('\n')+'\n',this.lines.length);return;}
    }
  }
  async run(){
    this.stop();const controller=new AbortController();this.controller=controller;const signal=controller.signal;
    while(!signal.aborted){
      try{
        this.onStatus({state:this.cursor?'reconnecting':'connecting',count:this.lines.length});await this.connect(signal);
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
    const controller=this.controller,selectionController=this.selectionController,reader=this._reader;
    this.controller=null;this.selectionController=null;this._reader=null;this.generation++;
    controller?.abort();selectionController?.abort();
    // An idle SSE read can survive request abort; cancel its owned reader too.
    reader?.cancel().catch(()=>{});
  }
  async download(){return(await this.request('/api/v2/download')).blob();}
}
