const files = import.meta.glob('../../examples/*.ndjson', { query: '?raw', import: 'default' });
const nativeCurrent = import.meta.glob('../../samples/realtime/android-adb-emulator-5556-user-0.ndjson', {query:'?raw',import:'default'});
export const sampleOptions = [
 ['realtime-android','Android emulator · recorded current capture'],
 ['viewer-three-origin','Three origins · SDK and customer handler'],
 ['handler-no-http','Handler · no HTTP'], ['handler-throw','Handler · throws, SDK continues'],
 ['handler-cancelled','Handler · cancelled'], ['handler-stopped','Handler · observation stopped'],
 ['handler-interrupted','Handler · missing end'], ['handler-http-outlives-return','Handler · HTTP completes after return'], ['handler-repeated-nested','Handlers · repeated and nested SDK callback'], ['handler-http','Handler · nested HTTP'],
 ['multi-session','Six origins · multiple sessions'], ['stream-read-timeout','200 headers · body read timeout'],
 ['redacted-truncated','Redacted + truncated body'], ['concurrent','Concurrent requests'],
 ['ios-logical-transactions','iOS · native transactions'], ['manual-minimal','Manual · minimal capture'],
 ['redirect','Redirect'], ['retry','Retry'], ['interrupted','Interrupted recording'],
];
export async function loadSample(id) {
 const key=id==='realtime-android'?'../../samples/realtime/android-adb-emulator-5556-user-0.ndjson':`../../examples/${id}.ndjson`;
 return [{name:`${id}.ndjson`,text:await (nativeCurrent[key]||files[key])()}];
}
export async function loadMalformedSample() {
 const [file]=await loadSample('handler-no-http');
 return [{name:'malformed-example.ndjson',text:file.text+'not valid JSON\n'+JSON.stringify({schema_version:'9.9',event_type:'future.event'})+'\n'+ '{"schema_version":'}];
}
