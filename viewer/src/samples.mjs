const files = import.meta.glob('../../examples/*.ndjson', { query: '?raw', import: 'default' });
const live = import.meta.glob('../../samples/live/*.ndjson', { query: '?raw', import: 'default' });
const transferred = import.meta.glob('../../samples/transfer/*.ndjson', { query: '?raw', import: 'default' });
export const sampleOptions = [
 ['live','Live Android · successful + recovered sign-in'],
 ['transferred','Transferred Android + iOS · native captures'],
 ['handler-no-http','Handler · no HTTP'], ['handler-throw','Handler · throws, SDK continues'],
 ['handler-cancelled','Handler · cancelled'], ['handler-stopped','Handler · observation stopped'],
 ['handler-interrupted','Handler · missing end'], ['handler-http-outlives-return','Handler · HTTP completes after return'], ['handler-repeated-nested','Handlers · repeated and nested SDK callback'], ['handler-http','Handler · nested HTTP'],
 ['multi-session','Six origins · multiple sessions'], ['stream-read-timeout','200 headers · body read timeout'],
 ['redacted-truncated','Redacted + truncated body'], ['concurrent','Concurrent requests'],
 ['ios-logical-transactions','iOS · native transactions'], ['manual-minimal','Manual · minimal capture'],
 ['redirect','Redirect'], ['retry','Retry'], ['interrupted','Interrupted recording'],
];
export async function loadSample(id) {
 const key=id==='transferred'?'../../samples/transfer/multi-platform.ndjson':id==='live'?'../../samples/live/multi-session.ndjson':`../../examples/${id}.ndjson`;
 return [{name:id==='live'?'live-android-sessions.ndjson':`${id}.ndjson`,text:await (transferred[key]||live[key]||files[key])()}];
}
export async function loadMalformedSample() {
 const [file]=await loadSample('handler-no-http');
 return [{name:'malformed-example.ndjson',text:file.text+'not valid JSON\n'+JSON.stringify({schema_version:'9.9',event_type:'future.event'})+'\n'+ '{"schema_version":'}];
}
