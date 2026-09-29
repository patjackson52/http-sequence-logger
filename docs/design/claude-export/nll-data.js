// Network Log Lab — synthetic NDJSON fixtures, parser, and event reconstruction.
// Parsing/validation is separate from reconstruction, which is separate from layout (nll-layout.js).
// All data is SYNTHETIC. Credentials are placeholders ([REDACTED]).

const T0 = Date.parse('2026-09-21T09:12:03.000Z');
const ts = (ms) => new Date(T0 + ms).toISOString();

const UA_ANDROID = 'DemoAuth/2.4.0 (Android 14; okhttp/4.12.0)';
const UA_IOS = 'DemoAuth/2.4.0 (iOS 18.1; URLSession)';
const H_JSON = (ua) => [['Accept', 'application/json'], ['User-Agent', ua]];
const H_AUTH = (ua) => [['Accept', 'application/json'], ['Authorization', 'Bearer [REDACTED]'], ['User-Agent', ua]];
const R_HTTPBIN = (len) => [['Content-Type', 'application/json'], ['Content-Length', String(len)], ['Server', 'gunicorn/19.9.0'], ['Access-Control-Allow-Origin', '*'], ['Access-Control-Allow-Credentials', 'true']];
const R_DUMMY = (len, cookies) => [['Content-Type', 'application/json; charset=utf-8'], ['Content-Length', String(len)], ['X-Powered-By', 'Express']].concat(cookies ? [['Set-Cookie', 'accessToken=[REDACTED]; Path=/; HttpOnly'], ['Set-Cookie', 'refreshToken=[REDACTED]; Path=/; HttpOnly']] : []);

const B_CHALLENGE = '{"args":{"flow":"demo","step":["challenge","1"]},"headers":{"Accept":"application/json","Host":"httpbin.org","User-Agent":"DemoAuth/2.4.0"},"origin":"[REDACTED]","url":"https://httpbin.org/get?flow=demo&step=challenge&step=1"}';
const B_LOGIN_REQ = '{"username":"emilys","password":"[REDACTED]","expiresInMins":30}';
const B_LOGIN_RES = '{"id":1,"username":"emilys","email":"emily.johnson@x.dummyjson.com","firstName":"Emily","lastName":"Johnson","gender":"female","image":"https://dummyjson.com/icon/emilys/128","accessToken":"[REDACTED]","refreshToken":"[REDACTED]"}';
const B_ME = '{"id":1,"firstName":"Emily","lastName":"Johnson","maidenName":"Smith","age":28,"gender":"female","email":"emily.johnson@x.dummyjson.com","username":"emilys","role":"admin"}';
const B_ME_TRUNC = '{"id":1,"firstName":"Emily","lastName":"Johnson","maidenName":"Smith","age":28,"gender":"female","email":"emily.johnson@x.dummyjson.com","phone":"[REDACTED]","username":"emilys","birthDate":"1996-5-30","image":"https://dummyjson.com/icon/emilys/128","bloodGroup":"O-","height":193.24,"weight":63.16,"eyeColor":"Green","hair":{"color":"Brown","type":"Curly"},"ip":"[REDACTED]","address":{"address":"626 Main Street","city":"Phoenix","state":"Mississippi","stateCode":"MS","postalCode":"29112","coordinates":{"lat":-77.16213,"lng":-92.084824},"country":"United States"},"macAddress":"[REDACTED]","university":"University of Wisconsin--Madison","bank":{"cardExpire":"[REDACTED]","cardNumber":"[REDACTED]","cardType":"Elo","currency":"CNY","iban":"[REDACTED]"},"company":{"department":"Engineering","name":"Dooley, Kozey and Cronin","title":"Sales Manager","address":{"address":"263 Tenth Street","city":"San Francisco","state":"Wisconsin","stateCode":"WI","postalCode":"37657","coordinates":{"lat":71.814525,"lng":-161.150263},"country":"United States"}},"ein":"977-175","ssn":"[REDACTED]","userAgent":"Mozilla/5.0 (Windows NT 6.1; Win64; x64)"';
const B_REFRESH_REQ = '{"refreshToken":"[REDACTED]","expiresInMins":30}';
const B_REFRESH_RES = '{"accessToken":"[REDACTED]","refreshToken":"[REDACTED]"}';
const B_TODO = '{"userId":1,"id":1,"title":"delectus aut autem","completed":false}';
const B_401 = '{"message":"Token Expired!"}';
const B_RECEIPT = '{"event":"demo_flow_complete","result":"ok","sdk":"DemoAuth/2.4.0"}';
const B_RECEIPT_RES = '{"json":{"event":"demo_flow_complete","result":"ok","sdk":"DemoAuth/2.4.0"},"origin":"[REDACTED]","url":"https://httpbin.org/post"}';

// Small DSL: build a session's events with monotonic ms offsets.
function session(cfg, build) {
  const ev = [];
  const push = (type, ms, o) => ev.push(Object.assign({ v: 1, type, ts: ts(ms), sessionId: cfg.sessionId }, o));
  let rec = null;
  const api = {
    start(ms, extra) { push('session.start', ms, Object.assign({ sessionName: cfg.name, sessionIdSource: cfg.source, platform: cfg.platform, sdk: cfg.sdk, app: 'Sample App 1.8.0 (demo)' }, extra)); },
    recStart(ms, id, extra) { rec = id; push('recording.start', ms, Object.assign({ recordingId: id }, extra)); },
    recStop(ms, reason) { push('recording.stop', ms, { recordingId: rec, reason }); rec = null; },
    opStart(ms, id, o) { push('operation.start', ms, Object.assign({ opId: id, recordingId: rec }, o)); },
    opEnd(ms, id, result, extra) { push('operation.end', ms, Object.assign({ opId: id, recordingId: rec, result }, extra)); },
    req(ms, id, o) { push('request.start', ms, Object.assign({ reqId: id, recordingId: rec }, o)); },
    hdr(ms, id, status, headers, extra) { push('response.headers', ms, Object.assign({ reqId: id, status, headers }, extra)); },
    body(ms, id, o) { push('response.body', ms, Object.assign({ reqId: id }, o)); },
    end(ms, id, outcome, extra) { push('request.end', ms, Object.assign({ reqId: id, outcome }, extra)); },
    sessionEnd(ms) { push('session.end', ms, {}); },
  };
  build(api);
  return ev;
}

const TRACE = (n) => ({ traceId: `4bf92f3577b34da6a3ce929d0e0e47${String(n).padStart(2, '0')}`, spanId: `00f067aa0ba9${String(n).padStart(4, '0')}` });
const NATIVE_H2 = { native: { protocol: 'h2', tlsResumed: true, redirectCount: 0, connectionReused: true } };

// ---- Session 1: successful demo sign-in -------------------------------------------------
const S1 = session({ sessionId: 'sess_9c1e-demo-ok', name: 'Sign-in — success', source: 'sdk', platform: 'android', sdk: 'DemoAuth 2.4.0 (Kotlin)' }, (s) => {
  s.start(0);
  s.recStart(10, 'rec_a1', { trigger: 'session.start' });
  s.opStart(40, 'op_signin', { owner: 'app', component: 'SampleApp.LoginViewModel', method: 'signIn(username)', callsite: 'LoginViewModel.kt:64' });
  s.opStart(55, 'op_auth', { owner: 'sdk', parentOpId: 'op_signin', component: 'DemoAuth.AuthClient', method: 'authenticate(credentials)', callsite: 'AuthClient.kt:88' });
  s.req(80, 'r1', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'GET', url: 'https://httpbin.org/get?flow=demo&step=challenge&step=1', headers: H_JSON(UA_ANDROID), body: null, callsite: 'ChallengeApi.kt:31' }, TRACE(1), NATIVE_H2));
  s.hdr(262, 'r1', 200, R_HTTPBIN(388));
  s.body(275, 'r1', { body: B_CHALLENGE, bodyState: 'captured', bytes: 388 });
  s.end(276, 'r1', 'success');
  s.req(300, 'r2', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'POST', url: 'https://httpbin.org/post', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: '{"challenge":"[REDACTED]","proof":"[REDACTED]","flow":"demo"}', bodyState: 'redacted', bodyBytes: 132, callsite: 'ChallengeApi.kt:52' }, TRACE(2), NATIVE_H2));
  s.hdr(510, 'r2', 200, R_HTTPBIN(512));
  s.body(521, 'r2', { body: '{"json":{"challenge":"[REDACTED]","flow":"demo","proof":"[REDACTED]"},"origin":"[REDACTED]","url":"https://httpbin.org/post"}', bodyState: 'redacted', bytes: 512 });
  s.end(522, 'r2', 'success');
  s.req(530, 'r3', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'POST', url: 'https://dummyjson.com/auth/login', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: B_LOGIN_REQ, bodyState: 'redacted', bodyBytes: 71, callsite: 'LoginApi.kt:27' }, TRACE(3), NATIVE_H2));
  s.hdr(790, 'r3', 200, R_DUMMY(742, true));
  s.body(801, 'r3', { body: B_LOGIN_RES, bodyState: 'redacted', bytes: 742 });
  s.end(802, 'r3', 'success');
  s.opEnd(805, 'op_auth', 'ok');
  s.opStart(810, 'op_prefetch', { owner: 'sdk', parentOpId: 'op_signin', component: 'DemoAuth.ProfileClient', method: 'prefetchProfile()', callsite: 'ProfileClient.kt:40' });
  s.req(815, 'r4', Object.assign({ opId: 'op_prefetch', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'GET', url: 'https://dummyjson.com/auth/me', headers: H_AUTH(UA_ANDROID), body: null, callsite: 'ProfileClient.kt:58' }, TRACE(4), NATIVE_H2));
  s.opEnd(830, 'op_prefetch', 'ok'); // method returns before the request finishes (async)
  s.hdr(1040, 'r4', 200, R_DUMMY(1180));
  s.body(1049, 'r4', { body: B_ME_TRUNC, bodyState: 'truncated', bytes: 1180, capturedBytes: 512, limit: 512 });
  s.end(1050, 'r4', 'success');
  s.opStart(1100, 'op_refresh', { owner: 'sdk', parentOpId: 'op_signin', component: 'DemoAuth.TokenStore', method: 'refresh()', callsite: 'TokenStore.kt:112' });
  s.req(1105, 'r5', Object.assign({ opId: 'op_refresh', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'POST', url: 'https://dummyjson.com/auth/refresh', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: B_REFRESH_REQ, bodyState: 'redacted', bodyBytes: 58, callsite: 'TokenStore.kt:131' }, TRACE(5), NATIVE_H2));
  s.hdr(1320, 'r5', 200, R_DUMMY(96, true));
  s.body(1326, 'r5', { body: B_REFRESH_RES, bodyState: 'redacted', bytes: 96 });
  s.end(1327, 'r5', 'success');
  s.opEnd(1330, 'op_refresh', 'ok');
  s.opStart(1350, 'op_profile', { owner: 'sdk', parentOpId: 'op_signin', component: 'DemoAuth.ProfileClient', method: 'getProfile()', callsite: 'ProfileClient.kt:72' });
  s.req(1352, 'r6', Object.assign({ opId: 'op_profile', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'GET', url: 'https://dummyjson.com/auth/me', headers: H_AUTH(UA_ANDROID), body: null, callsite: 'ProfileClient.kt:58' }, TRACE(6), NATIVE_H2));
  s.hdr(1560, 'r6', 200, R_DUMMY(219));
  s.body(1566, 'r6', { body: B_ME, bodyState: 'captured', bytes: 219 });
  s.end(1567, 'r6', 'success');
  s.opEnd(1570, 'op_profile', 'ok');
  s.opEnd(1580, 'op_signin', 'ok');
  // Manually recorded by the customer app — partial metadata (no headers, no header timestamp)
  s.req(1600, 'r7', { owner: 'app', adapter: 'manual', component: 'SampleApp.TodoRepository', method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos/1', headersState: 'not_recorded', bodyState: 'not_applicable', callsite: 'TodoRepository.kt:22' });
  s.body(1790, 'r7', { body: B_TODO, bodyState: 'captured', bytes: 83 });
  s.end(1791, 'r7', 'success', { status: 200 });
  s.opStart(1800, 'op_receipt', { owner: 'sdk', component: 'DemoAuth.Telemetry', method: 'sendReceipt()', callsite: 'Telemetry.kt:19' });
  s.req(1805, 'r8', Object.assign({ opId: 'op_receipt', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'POST', url: 'https://httpbin.org/post', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: B_RECEIPT, bodyState: 'captured', bodyBytes: 68, callsite: 'Telemetry.kt:33' }, TRACE(8), NATIVE_H2));
  s.hdr(2010, 'r8', 200, R_HTTPBIN(201));
  s.body(2016, 'r8', { body: B_RECEIPT_RES, bodyState: 'captured', bytes: 201 });
  s.end(2017, 'r8', 'success');
  s.opEnd(2020, 'op_receipt', 'ok');
  s.recStop(2030, 'session.end');
  s.sessionEnd(2031);
});

// ---- Session 2: 401 → refresh → retry --------------------------------------------------
const S2 = session({ sessionId: 'sess_2f77-demo-401', name: 'Sign-in — 401 recovered', source: 'sdk', platform: 'ios', sdk: 'DemoAuth 2.4.0 (Swift)' }, (s) => {
  const A = 'urlsession-delegate';
  s.start(60000);
  s.recStart(60010, 'rec_b1', { trigger: 'session.start' });
  s.opStart(60040, 'op_signin', { owner: 'app', component: 'SampleApp.LoginViewModel', method: 'signIn(username:)', callsite: 'LoginViewModel.swift:71' });
  s.opStart(60055, 'op_auth', { owner: 'sdk', parentOpId: 'op_signin', component: 'DemoAuth.AuthClient', method: 'authenticate(credentials:)', callsite: 'AuthClient.swift:94' });
  s.req(60080, 'r1', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: A, method: 'GET', url: 'https://httpbin.org/get?flow=demo&step=challenge&step=1', headers: H_JSON(UA_IOS), body: null }, TRACE(11)));
  s.hdr(60290, 'r1', 200, R_HTTPBIN(388));
  s.body(60301, 'r1', { body: B_CHALLENGE, bodyState: 'captured', bytes: 388 });
  s.end(60302, 'r1', 'success');
  s.req(60320, 'r2', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: A, method: 'POST', url: 'https://httpbin.org/post', headers: H_JSON(UA_IOS).concat([['Content-Type', 'application/json']]), body: '{"challenge":"[REDACTED]","proof":"[REDACTED]","flow":"demo"}', bodyState: 'redacted', bodyBytes: 132 }, TRACE(12)));
  s.hdr(60540, 'r2', 200, R_HTTPBIN(512));
  s.body(60548, 'r2', { body: '{"json":{"challenge":"[REDACTED]","flow":"demo","proof":"[REDACTED]"},"origin":"[REDACTED]"}', bodyState: 'redacted', bytes: 512 });
  s.end(60549, 'r2', 'success');
  s.req(60560, 'r3', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: A, method: 'POST', url: 'https://dummyjson.com/auth/login', headers: H_JSON(UA_IOS).concat([['Content-Type', 'application/json']]), body: B_LOGIN_REQ, bodyState: 'redacted', bodyBytes: 71 }, TRACE(13)));
  s.hdr(60830, 'r3', 200, R_DUMMY(742, true));
  s.body(60840, 'r3', { body: B_LOGIN_RES, bodyState: 'redacted', bytes: 742 });
  s.end(60841, 'r3', 'success');
  s.opEnd(60845, 'op_auth', 'ok');
  s.opStart(60860, 'op_profile', { owner: 'sdk', parentOpId: 'op_signin', component: 'DemoAuth.ProfileClient', method: 'getProfile()', callsite: 'ProfileClient.swift:66' });
  s.req(60865, 'r4', Object.assign({ opId: 'op_profile', owner: 'sdk', adapter: A, method: 'GET', url: 'https://dummyjson.com/auth/me', headers: H_AUTH(UA_IOS), body: null, note: 'Used cached token from a previous demo run' }, TRACE(14)));
  s.hdr(61070, 'r4', 401, R_DUMMY(27), { statusText: 'Unauthorized' });
  s.body(61074, 'r4', { body: B_401, bodyState: 'captured', bytes: 27 });
  s.end(61075, 'r4', 'http_error');
  s.opStart(61080, 'op_refresh', { owner: 'sdk', parentOpId: 'op_profile', component: 'DemoAuth.TokenStore', method: 'refresh()', callsite: 'TokenStore.swift:120' });
  s.req(61085, 'r5', Object.assign({ opId: 'op_refresh', owner: 'sdk', adapter: A, method: 'POST', url: 'https://dummyjson.com/auth/refresh', headers: H_JSON(UA_IOS).concat([['Content-Type', 'application/json']]), body: B_REFRESH_REQ, bodyState: 'redacted', bodyBytes: 58 }, TRACE(15)));
  s.hdr(61300, 'r5', 200, R_DUMMY(96, true));
  s.body(61306, 'r5', { body: B_REFRESH_RES, bodyState: 'redacted', bytes: 96 });
  s.end(61307, 'r5', 'success');
  s.opEnd(61310, 'op_refresh', 'ok');
  s.req(61320, 'r6', Object.assign({ opId: 'op_profile', owner: 'sdk', adapter: A, method: 'GET', url: 'https://dummyjson.com/auth/me', headers: H_AUTH(UA_IOS), body: null, retryOf: 'r4', retryReason: 'token refreshed after 401' }, TRACE(16)));
  s.hdr(61530, 'r6', 200, R_DUMMY(219));
  s.body(61536, 'r6', { body: B_ME, bodyState: 'captured', bytes: 219 });
  s.end(61537, 'r6', 'success');
  s.opEnd(61540, 'op_profile', 'ok');
  s.opEnd(61550, 'op_signin', 'ok');
  s.opStart(61560, 'op_receipt', { owner: 'sdk', component: 'DemoAuth.Telemetry', method: 'sendReceipt()', callsite: 'Telemetry.swift:21' });
  s.req(61565, 'r7', Object.assign({ opId: 'op_receipt', owner: 'sdk', adapter: A, method: 'POST', url: 'https://httpbin.org/post', headers: H_JSON(UA_IOS).concat([['Content-Type', 'application/json']]), body: B_RECEIPT, bodyState: 'captured', bodyBytes: 68 }, TRACE(17)));
  s.hdr(61770, 'r7', 200, R_HTTPBIN(201));
  s.body(61776, 'r7', { body: B_RECEIPT_RES, bodyState: 'captured', bytes: 201 });
  s.end(61777, 'r7', 'success');
  s.opEnd(61780, 'op_receipt', 'ok');
  s.recStop(61790, 'session.end');
  s.sessionEnd(61791);
});

// ---- Session 3: body-read timeout, explicit stop, interrupted recording ------------------------
const S3 = session({ sessionId: 'cust-sync-7f3a', name: 'Profile sync — body-read timeout', source: 'customer', platform: 'android', sdk: 'DemoAuth 2.4.0 (Kotlin)' }, (s) => {
  const B = 120000;
  s.start(B);
  s.recStart(B + 10, 'rec_c1', { trigger: 'manual' });
  s.opStart(B + 30, 'op_sync', { owner: 'app', component: 'SampleApp.SyncWorker', method: 'doWork()', callsite: 'SyncWorker.kt:41' });
  s.opStart(B + 45, 'op_profile', { owner: 'sdk', parentOpId: 'op_sync', component: 'DemoAuth.ProfileClient', method: 'getProfile()', callsite: 'ProfileClient.kt:72' });
  s.req(B + 60, 'r1', Object.assign({ opId: 'op_profile', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'POST', url: 'https://dummyjson.com/auth/login', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: B_LOGIN_REQ, bodyState: 'redacted', bodyBytes: 71 }, TRACE(21), NATIVE_H2));
  s.hdr(B + 320, 'r1', 200, R_DUMMY(742, true));
  s.body(B + 331, 'r1', { body: B_LOGIN_RES, bodyState: 'redacted', bytes: 742 });
  s.end(B + 332, 'r1', 'success');
  s.req(B + 340, 'r2', Object.assign({ opId: 'op_profile', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'GET', url: 'https://dummyjson.com/auth/me?include=address&include=company', headers: H_AUTH(UA_ANDROID), body: null }, TRACE(22), NATIVE_H2));
  s.hdr(B + 552, 'r2', 200, R_DUMMY(1180));
  s.body(B + 10553, 'r2', { body: B_ME_TRUNC.slice(0, 256), bodyState: 'partial', bytes: 1180, capturedBytes: 256 });
  s.end(B + 10554, 'r2', 'timeout', { error: 'java.net.SocketTimeoutException: Read timed out after 10000 ms while reading response body', phase: 'body' });
  s.opEnd(B + 10560, 'op_profile', 'error');
  s.opStart(B + 10600, 'op_refresh', { owner: 'sdk', parentOpId: 'op_sync', component: 'DemoAuth.TokenStore', method: 'refresh()', callsite: 'TokenStore.kt:112' });
  s.req(B + 10605, 'r3', Object.assign({ opId: 'op_refresh', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'POST', url: 'https://dummyjson.com/auth/refresh', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: B_REFRESH_REQ, bodyState: 'redacted', bodyBytes: 58 }, TRACE(23)));
  s.recStop(B + 10700, 'manual'); // developer stopped observing while r3 was in flight → outcome unknown
  // Second recording period. Clock offset relative to rec_c1 is not asserted by the SDK.
  s.recStart(B + 42000, 'rec_c2', { trigger: 'manual', clockNote: 'monotonic clock restarted; wall clock only' });
  s.opStart(B + 42030, 'op_sync2', { owner: 'app', component: 'SampleApp.SyncWorker', method: 'doWork()', callsite: 'SyncWorker.kt:41' });
  s.opStart(B + 42045, 'op_profile2', { owner: 'sdk', parentOpId: 'op_sync2', component: 'DemoAuth.ProfileClient', method: 'getProfile()', callsite: 'ProfileClient.kt:72' });
  s.req(B + 42060, 'r4', Object.assign({ opId: 'op_profile2', owner: 'sdk', adapter: 'okhttp-interceptor', method: 'GET', url: 'https://dummyjson.com/auth/me', headers: H_AUTH(UA_ANDROID), body: null }, TRACE(24)));
  // file ends here — interrupted capture, no recording.stop / session.end
});

// ---- Session 4: six origins ------------------------------------------------------------
const S4 = session({ sessionId: 'sess_b0d4-demo-checkout', name: 'Checkout demo — six origins', source: 'sdk', platform: 'android', sdk: 'DemoAuth 2.4.0 (Kotlin)' }, (s) => {
  const B = 300000, A = 'okhttp-interceptor';
  const CDN = 'https://api.demo-cdn.example:8443', TEL = 'https://telemetry.demo.example', LOCAL = 'http://localhost:8080';
  s.start(B);
  s.recStart(B + 10, 'rec_d1', { trigger: 'session.start' });
  s.opStart(B + 30, 'op_checkout', { owner: 'app', component: 'SampleApp.CheckoutViewModel', method: 'loadCheckout()', callsite: 'CheckoutViewModel.kt:52' });
  s.opStart(B + 40, 'op_auth', { owner: 'sdk', parentOpId: 'op_checkout', component: 'DemoAuth.AuthClient', method: 'authenticate(credentials)', callsite: 'AuthClient.kt:88' });
  s.req(B + 50, 'r1', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: A, method: 'GET', url: 'https://httpbin.org/get?flow=demo&step=challenge', headers: H_JSON(UA_ANDROID), body: null }, TRACE(31)));
  s.hdr(B + 240, 'r1', 200, R_HTTPBIN(360)); s.body(B + 248, 'r1', { body: B_CHALLENGE, bodyState: 'captured', bytes: 360 }); s.end(B + 249, 'r1', 'success');
  s.req(B + 260, 'r2', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: A, method: 'POST', url: 'https://dummyjson.com/auth/login', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: B_LOGIN_REQ, bodyState: 'redacted', bodyBytes: 71 }, TRACE(32)));
  s.hdr(B + 520, 'r2', 200, R_DUMMY(742, true)); s.body(B + 530, 'r2', { body: B_LOGIN_RES, bodyState: 'redacted', bytes: 742 }); s.end(B + 531, 'r2', 'success');
  s.opEnd(B + 535, 'op_auth', 'ok');
  s.req(B + 540, 'r3', { opId: 'op_checkout', owner: 'app', adapter: 'manual', component: 'SampleApp.UserRepository', method: 'GET', url: 'https://jsonplaceholder.typicode.com/users/1', headersState: 'not_recorded', bodyState: 'not_applicable', callsite: 'UserRepository.kt:18' });
  s.end(B + 760, 'r3', 'success', { status: 200 });
  s.req(B + 545, 'r4', Object.assign({ opId: 'op_checkout', owner: 'app', adapter: A, method: 'GET', url: `${CDN}/catalog/v2/items?category=demo&limit=20&sort=price&sort=name`, headers: H_JSON(UA_ANDROID), body: null, component: 'SampleApp.CatalogRepository' }, TRACE(34)));
  s.hdr(B + 810, 'r4', 200, [['Content-Type', 'application/json'], ['Content-Length', '4188'], ['Cache-Control', 'max-age=60'], ['ETag', '"c0ffee-42"']]); s.body(B + 830, 'r4', { body: '{"items":[{"id":42,"name":"Demo kettle","price":39.9},{"id":43,"name":"Demo mug","price":9.5}],"total":20}', bodyState: 'truncated', bytes: 4188, capturedBytes: 512, limit: 512 }); s.end(B + 831, 'r4', 'success');
  s.req(B + 840, 'r5', Object.assign({ opId: 'op_checkout', owner: 'app', adapter: A, method: 'GET', url: `${CDN}/catalog/v2/prices?currency=EUR`, headers: H_JSON(UA_ANDROID).concat([['If-None-Match', '"p-77"']]), body: null, component: 'SampleApp.CatalogRepository' }, TRACE(35)));
  s.hdr(B + 990, 'r5', 304, [['ETag', '"p-77"'], ['Cache-Control', 'max-age=60']], { statusText: 'Not Modified' }); s.end(B + 991, 'r5', 'success');
  s.opStart(B + 1000, 'op_flush', { owner: 'sdk', component: 'DemoAuth.Telemetry', method: 'flush()', callsite: 'Telemetry.kt:58' });
  s.req(B + 1005, 'r6', Object.assign({ opId: 'op_flush', owner: 'sdk', adapter: A, method: 'POST', url: `${TEL}/v1/events`, headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/x-ndjson']]), body: '{"e":"sdk.init"}\n{"e":"auth.ok"}', bodyState: 'captured', bodyBytes: 33 }, TRACE(36)));
  s.hdr(B + 1180, 'r6', 202, [['Content-Length', '0']], { statusText: 'Accepted' }); s.end(B + 1181, 'r6', 'success');
  s.req(B + 1190, 'r7', Object.assign({ opId: 'op_flush', owner: 'sdk', adapter: A, method: 'POST', url: `${TEL}/v1/events`, headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/x-ndjson']]), body: '{"e":"profile.read"}', bodyState: 'captured', bodyBytes: 20 }, TRACE(37)));
  s.hdr(B + 1420, 'r7', 503, [['Content-Type', 'text/plain'], ['Retry-After', '1']], { statusText: 'Service Unavailable' }); s.body(B + 1422, 'r7', { body: 'upstream unavailable', bodyState: 'captured', bytes: 20 }); s.end(B + 1423, 'r7', 'http_error');
  s.req(B + 1400, 'r9', Object.assign({ opId: 'op_checkout', owner: 'app', adapter: A, method: 'GET', url: `${LOCAL}/debug/config`, headers: H_JSON(UA_ANDROID), body: null, component: 'SampleApp.DebugConfig' }, TRACE(39)));
  s.hdr(B + 1440, 'r9', 200, [['Content-Type', 'application/json'], ['Content-Length', '61']]); s.body(B + 1441, 'r9', { body: '{"featureFlags":{"newCheckout":true},"env":"local"}', bodyState: 'captured', bytes: 61 }); s.end(B + 1442, 'r9', 'success');
  s.req(B + 2440, 'r8', Object.assign({ opId: 'op_flush', owner: 'sdk', adapter: A, method: 'POST', url: `${TEL}/v1/events`, headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/x-ndjson']]), body: '{"e":"profile.read"}', bodyState: 'captured', bodyBytes: 20, retryOf: 'r7', retryReason: 'Retry-After: 1' }, TRACE(38)));
  s.hdr(B + 2620, 'r8', 202, [['Content-Length', '0']], { statusText: 'Accepted' }); s.end(B + 2621, 'r8', 'success');
  s.opEnd(B + 2625, 'op_flush', 'ok');
  s.opStart(B + 2630, 'op_profile', { owner: 'sdk', parentOpId: 'op_checkout', component: 'DemoAuth.ProfileClient', method: 'getProfile()', callsite: 'ProfileClient.kt:72' });
  s.req(B + 2635, 'r10', Object.assign({ opId: 'op_profile', owner: 'sdk', adapter: A, method: 'GET', url: 'https://dummyjson.com/auth/me', headers: H_AUTH(UA_ANDROID), body: null }, TRACE(40)));
  s.hdr(B + 2850, 'r10', 200, R_DUMMY(219)); s.body(B + 2856, 'r10', { body: B_ME, bodyState: 'captured', bytes: 219 }); s.end(B + 2857, 'r10', 'success');
  s.opEnd(B + 2860, 'op_profile', 'ok');
  s.req(B + 2870, 'r11', Object.assign({ opId: 'op_checkout', owner: 'app', adapter: A, method: 'POST', url: 'https://jsonplaceholder.typicode.com/posts', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: '{"title":"demo order","body":"2 items","userId":1}', bodyState: 'captured', bodyBytes: 49, component: 'SampleApp.OrderRepository' }, TRACE(41)));
  s.hdr(B + 3120, 'r11', 201, [['Content-Type', 'application/json; charset=utf-8'], ['Content-Length', '64'], ['Location', '/posts/101']], { statusText: 'Created' }); s.body(B + 3124, 'r11', { body: '{"title":"demo order","body":"2 items","userId":1,"id":101}', bodyState: 'captured', bytes: 64 }); s.end(B + 3125, 'r11', 'success');
  s.req(B + 3130, 'r12', Object.assign({ opId: 'op_checkout', owner: 'app', adapter: A, method: 'GET', url: `${LOCAL}/debug/flags`, headers: H_JSON(UA_ANDROID), body: null, component: 'SampleApp.DebugConfig' }, TRACE(42)));
  s.end(B + 3162, 'r12', 'transport_failure', { error: 'java.net.ConnectException: Failed to connect to localhost/127.0.0.1:8080 (ECONNREFUSED)', phase: 'connect' });
  s.opStart(B + 3170, 'op_receipt', { owner: 'sdk', component: 'DemoAuth.Telemetry', method: 'sendReceipt()', callsite: 'Telemetry.kt:19' });
  s.req(B + 3175, 'r13', Object.assign({ opId: 'op_receipt', owner: 'sdk', adapter: A, method: 'POST', url: 'https://httpbin.org/post', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: B_RECEIPT, bodyState: 'captured', bodyBytes: 68 }, TRACE(43)));
  s.hdr(B + 3380, 'r13', 200, R_HTTPBIN(201)); s.body(B + 3386, 'r13', { body: B_RECEIPT_RES, bodyState: 'captured', bytes: 201 }); s.end(B + 3387, 'r13', 'success');
  s.opEnd(B + 3390, 'op_receipt', 'ok');
  s.req(B + 3400, 'r14', Object.assign({ opId: 'op_checkout', owner: 'app', adapter: A, method: 'GET', url: `${CDN}/catalog/v2/items/42`, headers: H_JSON(UA_ANDROID), body: null, component: 'SampleApp.CatalogRepository' }, TRACE(44)));
  s.end(B + 3455, 'r14', 'cancelled', { error: 'Call cancelled: CheckoutViewModel cleared (user navigated back)' });
  s.opEnd(B + 3460, 'op_checkout', 'cancelled');
  s.recStop(B + 3470, 'session.end');
  s.sessionEnd(B + 3471);
});

// ---- Session 5: SDK → app handler → SDK (mirrors samples/live/successful-sign-in.ndjson) ------
const S5 = session({ sessionId: 'sess_25cc-demo-handler', name: 'Sign-in — app handler (loadTask)', source: 'sdk', platform: 'android', sdk: 'DemoAuth 2.4.0 (Kotlin)' }, (s) => {
  const B = 400000, A = 'okhttp-interceptor';
  s.start(B);
  s.recStart(B + 5, 'rec_e1', { trigger: 'session.start' });
  s.opStart(B + 6, 'op_signin', { owner: 'app', component: 'SampleApp', method: 'signIn(handler)', callsite: 'SampleFlow.kt:41' });
  s.opStart(B + 7, 'op_auth', { owner: 'sdk', parentOpId: 'op_signin', component: 'DemoAuthSdk', method: 'authenticate(handler)', callsite: 'DemoAuthSdk.kt:12' });
  s.req(B + 9, 'r1', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: A, method: 'GET', url: 'https://httpbin.org/uuid', headers: H_JSON(UA_ANDROID), body: null }, TRACE(51)));
  s.hdr(B + 1024, 'r1', 200, R_HTTPBIN(53)); s.body(B + 1028, 'r1', { body: '{"uuid":"ee324ee9-21bb-47d2-a0a1-41d71cbb468f"}', bodyState: 'captured', bytes: 53 }); s.end(B + 1028, 'r1', 'success');
  s.req(B + 1407, 'r2', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: A, method: 'POST', url: 'https://dummyjson.com/auth/login', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json; charset=utf-8']]), body: B_LOGIN_REQ, bodyState: 'redacted', bodyBytes: 63 }, TRACE(52)));
  s.hdr(B + 3311, 'r2', 200, R_DUMMY(930, true)); s.body(B + 3316, 'r2', { body: B_LOGIN_RES, bodyState: 'redacted', bytes: 930 }); s.end(B + 3316, 'r2', 'success');
  s.req(B + 3317, 'r3', Object.assign({ opId: 'op_auth', owner: 'sdk', adapter: A, method: 'GET', url: 'https://dummyjson.com/auth/me', headers: H_AUTH(UA_ANDROID), body: null }, TRACE(53)));
  s.hdr(B + 3452, 'r3', 200, R_DUMMY(1423)); s.body(B + 3458, 'r3', { body: B_ME, bodyState: 'redacted', bytes: 1423 }); s.end(B + 3461, 'r3', 'success');
  // SDK hands control to the app-supplied handler; the SDK method stays open and waits.
  s.opStart(B + 3710, 'op_handler', { owner: 'app', parentOpId: 'op_auth', component: 'CustomerTaskHandler', method: 'loadTask()', callsite: 'CustomerTaskHandler.kt:18', invocation: { kind: 'handler', dispatch: 'synchronous', caller: { owner: 'sdk', component: 'DemoAuthSdk', method: 'authenticate' } } });
  s.req(B + 3711, 'r4', { opId: 'op_handler', owner: 'app', adapter: 'manual', component: 'CustomerTaskClient', method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos/1', headersState: 'not_recorded', bodyState: 'not_applicable', callsite: 'CustomerTaskClient.kt:22' });
  s.hdr(B + 5245, 'r4', 200, [['Content-Type', 'application/json; charset=utf-8'], ['cf-cache-status', 'HIT']]);
  s.body(B + 5246, 'r4', { body: B_TODO, bodyState: 'captured', bytes: 83 }); s.end(B + 5247, 'r4', 'success');
  s.opEnd(B + 5247, 'op_handler', 'ok', { completion: 'returned' });
  s.opStart(B + 5247, 'op_accept', { owner: 'sdk', parentOpId: 'op_auth', component: 'DemoAuthSdk', method: 'acceptTask()', callsite: 'DemoAuthSdk.kt:44' });
  s.opEnd(B + 5248, 'op_accept', 'ok');
  s.opEnd(B + 5250, 'op_auth', 'ok');
  s.opStart(B + 5251, 'op_complete', { owner: 'sdk', parentOpId: 'op_signin', component: 'DemoAuthSdk', method: 'completeDemo()', callsite: 'DemoAuthSdk.kt:58' });
  s.req(B + 5252, 'r5', Object.assign({ opId: 'op_complete', owner: 'sdk', adapter: A, method: 'POST', url: 'https://httpbin.org/anything/receipt', headers: H_JSON(UA_ANDROID).concat([['Content-Type', 'application/json']]), body: '{"challengeId":"ee324ee9-21bb-47d2-a0a1-41d71cbb468f","completed":true,"demo":true}', bodyState: 'captured', bodyBytes: 83 }, TRACE(55)));
  s.hdr(B + 5340, 'r5', 200, R_HTTPBIN(690)); s.body(B + 5342, 'r5', { body: '{"json":{"challengeId":"ee324ee9-21bb-47d2-a0a1-41d71cbb468f","completed":true,"demo":true},"origin":"[REDACTED]","url":"https://httpbin.org/anything/receipt"}', bodyState: 'redacted', bytes: 690 }); s.end(B + 5342, 'r5', 'success');
  s.opEnd(B + 5343, 'op_complete', 'ok');
  s.opEnd(B + 5344, 'op_signin', 'ok');
  s.recStop(B + 5350, 'session.end');
  s.sessionEnd(B + 5351);
});

const toNdjson = (evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';

const MALFORMED_TEXT = [
  JSON.stringify({ v: 1, type: 'session.start', ts: ts(500000), sessionId: 'sess_broken_export', sessionName: 'Broken export (partial)', platform: 'android', sdk: 'DemoAuth 2.4.0 (Kotlin)' }),
  JSON.stringify({ v: 1, type: 'recording.start', ts: ts(500010), sessionId: 'sess_broken_export', recordingId: 'rec_x1' }),
  '{"v":1,"type":"request.start","ts":"2026-09-21T09:20:23.100Z","sessionId":"sess_broken_export","recordingId":"rec_x1","reqId":"r1","method":"GET","url":"https://httpbin.org/get?flow=demo"',
  'W/System  ( 4211): A resource failed to call close.',
  JSON.stringify({ v: 1, type: 'metrics.tick', ts: ts(500200), sessionId: 'sess_broken_export', cpu: 0.12 }),
  JSON.stringify({ v: 1, type: 'response.headers', ts: ts(500300), sessionId: 'sess_broken_export', reqId: 'r9', status: 200, headers: [] }),
  JSON.stringify({ v: 1, type: 'request.start', ts: ts(500400), sessionId: 'sess_broken_export', recordingId: 'rec_x1', reqId: 'r2', owner: 'sdk', method: 'POST' }),
  JSON.stringify({ v: 1, type: 'request.start', ts: ts(500500), sessionId: 'sess_broken_export', recordingId: 'rec_x1', reqId: 'r3', owner: 'sdk', opId: null, adapter: 'okhttp-interceptor', method: 'POST', url: 'https://dummyjson.com/auth/login', headers: H_JSON(UA_ANDROID), body: B_LOGIN_REQ, bodyState: 'redacted', bodyBytes: 71 }),
  JSON.stringify({ v: 1, type: 'response.headers', ts: 'not-a-timestamp', sessionId: 'sess_broken_export', reqId: 'r3', status: 0, headers: [] }),
  JSON.stringify({ v: 1, type: 'request.end', ts: ts(500900), sessionId: 'sess_broken_export', reqId: 'r3', outcome: 'exploded' }),
  '',
].join('\n');

export const SAMPLE_FILES = {
  sample: { name: 'demoauth-sample-sessions.ndjson', text: toNdjson([].concat(S1, S2, S3, S4, S5)) },
  malformed: { name: 'broken-export.ndjson', text: MALFORMED_TEXT },
};

// ---------------------------------------------------------------------------------------
// Parser: text → events + diagnostics. Never evaluates content; only JSON.parse + field checks.
const KNOWN = new Set(['session.start', 'session.end', 'recording.start', 'recording.stop', 'operation.start', 'operation.end', 'request.start', 'response.headers', 'response.body', 'request.end']);
const OUTCOMES = new Set(['success', 'http_error', 'transport_failure', 'timeout', 'cancelled', 'unknown']);

export function parseNdjson(text) {
  const events = [], diagnostics = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let e;
    try { e = JSON.parse(raw); } catch (err) {
      diagnostics.push({ line, severity: 'error', code: 'invalid_json', message: 'Line is not valid JSON; skipped.', excerpt: raw.slice(0, 80) });
      return;
    }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { diagnostics.push({ line, severity: 'error', code: 'not_object', message: 'Event must be a JSON object; skipped.' }); return; }
    if (typeof e.type !== 'string') { diagnostics.push({ line, severity: 'error', code: 'missing_type', message: 'Event has no "type" string; skipped.' }); return; }
    if (!KNOWN.has(e.type)) { diagnostics.push({ line, severity: 'warning', code: 'unknown_type', message: `Unknown event type "${e.type}"; ignored.` }); return; }
    let tsMs = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (Number.isNaN(tsMs)) { diagnostics.push({ line, severity: 'warning', code: 'bad_timestamp', message: `Unparseable timestamp ${JSON.stringify(e.ts)}; event keeps file order but has no time.` }); tsMs = null; }
    if (e.type === 'request.start' && (typeof e.url !== 'string' || typeof e.reqId !== 'string')) { diagnostics.push({ line, severity: 'error', code: 'missing_field', message: `request.start needs "reqId" and "url"; skipped.` }); return; }
    if (e.type === 'response.headers' && e.status === 0) { diagnostics.push({ line, severity: 'warning', code: 'status_zero', message: 'status 0 is not an HTTP response; recorded as "no response received".' }); e = Object.assign({}, e, { status: null, statusInvalid: true }); }
    if (e.type === 'request.end' && e.outcome !== undefined && !OUTCOMES.has(e.outcome)) { diagnostics.push({ line, severity: 'warning', code: 'unknown_outcome', message: `Unknown outcome "${e.outcome}"; shown as unknown.` }); e = Object.assign({}, e, { outcome: 'unknown', outcomeRaw: e.outcome }); }
    events.push({ line, tsMs, raw, e });
  });
  return { events, diagnostics, lineCount: lines.filter((l) => l.trim()).length };
}

// ---------------------------------------------------------------------------------------
// Reconstruction: events → sessions → recordings / operations / exchanges.
const DEFAULT_PORT = { 'https:': '443', 'http:': '80' };
export function parseOrigin(url) {
  try {
    const u = new URL(url);
    const port = u.port || DEFAULT_PORT[u.protocol] || '';
    const explicit = u.port && u.port !== DEFAULT_PORT[u.protocol];
    const origin = `${u.protocol}//${u.hostname}${explicit ? ':' + u.port : ''}`;
    const query = [];
    u.searchParams.forEach((v, k) => query.push([k, v]));
    return { origin, host: u.hostname, port, scheme: u.protocol.replace(':', ''), label: explicit ? `${u.hostname}:${u.port}` : u.hostname, path: u.pathname, query, search: u.search, valid: true };
  } catch (err) {
    return { origin: '(invalid URL)', host: '(invalid)', port: '', scheme: '', label: '(invalid URL)', path: url, query: [], search: '', valid: false };
  }
}

const STATUS_TEXT = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
export const statusText = (s) => STATUS_TEXT[s] || '';

export function reconstruct(parsed) {
  const diagnostics = parsed.diagnostics.slice();
  const sessions = new Map();
  const getSession = (id, line) => {
    const key = id || '(no session id)';
    if (!sessions.has(key)) {
      if (!id) diagnostics.push({ line, severity: 'warning', code: 'no_session', message: 'Event has no sessionId; grouped under "(no session id)".' });
      sessions.set(key, { id: key, name: null, source: null, platform: null, sdk: null, app: null, started: null, ended: null, recordings: [], recMap: new Map(), operations: [], opMap: new Map(), exchanges: [], exMap: new Map(), implicit: !id ? true : false, firstLine: line });
    }
    return sessions.get(key);
  };
  parsed.events.forEach(({ line, tsMs, raw, e }) => {
    const s = getSession(e.sessionId, line);
    const rawEv = { line, raw, type: e.type, tsMs };
    switch (e.type) {
      case 'session.start':
        s.name = e.sessionName || null; s.source = e.sessionIdSource || null; s.platform = e.platform || null; s.sdk = e.sdk || null; s.app = e.app || null; s.started = tsMs; s.explicitStart = true; break;
      case 'session.end': s.ended = tsMs; break;
      case 'recording.start': {
        const r = { id: e.recordingId || `(unnamed@${line})`, startMs: tsMs, stopMs: null, stopReason: null, interrupted: true, trigger: e.trigger || null, clockNote: e.clockNote || null, line };
        s.recordings.push(r); s.recMap.set(r.id, r); break;
      }
      case 'recording.stop': {
        const r = s.recMap.get(e.recordingId);
        if (!r) { diagnostics.push({ line, severity: 'warning', code: 'unknown_recording', message: `recording.stop for unknown recording "${e.recordingId}".` }); break; }
        r.stopMs = tsMs; r.stopReason = e.reason || 'unspecified'; r.interrupted = false; break;
      }
      case 'operation.start': {
        const inv = e.invocation && typeof e.invocation === 'object' ? { kind: e.invocation.kind || 'unknown', dispatch: e.invocation.dispatch || 'unknown', caller: e.invocation.caller || null } : null;
        const op = { id: e.opId, parentId: e.parentOpId || null, owner: e.owner || 'unknown', component: e.component || null, method: e.method || null, callsite: e.callsite || null, recordingId: e.recordingId || null, startMs: tsMs, endMs: null, result: null, invocation: inv, completion: null, error: null, stopReason: null, exchanges: [], children: [], events: [rawEv] };
        s.operations.push(op); s.opMap.set(op.id, op);
        break;
      }
      case 'operation.end': {
        const op = s.opMap.get(e.opId);
        if (!op) { diagnostics.push({ line, severity: 'warning', code: 'unknown_operation', message: `operation.end for unknown operation "${e.opId}".` }); break; }
        op.endMs = tsMs; op.result = e.result || 'unspecified'; op.events.push(rawEv);
        if (op.invocation) { op.completion = COMPLETION_META[e.completion] ? e.completion : 'returned'; op.error = e.error || null; op.stopReason = e.stopReason || null; if (op.completion === 'observation_stopped') op.result = 'unknown'; }
        break;
      }
      case 'request.start': {
        const o = parseOrigin(e.url);
        if (!o.valid) diagnostics.push({ line, severity: 'warning', code: 'invalid_url', message: `Request ${e.reqId} has an unparseable URL.` });
        const x = {
          id: e.reqId, sessionId: s.id, recordingId: e.recordingId || null, opId: e.opId || null, owner: e.owner || 'unknown', adapter: e.adapter || null,
          component: e.component || null, callsite: e.callsite || null, method: e.method || '(no method)', url: e.url, ...o,
          reqHeaders: Array.isArray(e.headers) ? e.headers : null, reqHeadersState: Array.isArray(e.headers) ? 'captured' : (e.headersState || 'unavailable'),
          reqBody: typeof e.body === 'string' ? e.body : null, reqBodyState: typeof e.body === 'string' ? (e.bodyState || 'captured') : (e.body === null ? 'not_applicable' : (e.bodyState || 'unavailable')), reqBytes: e.bodyBytes ?? (typeof e.body === 'string' ? new TextEncoder().encode(e.body).length : null),
          status: null, statusText: null, statusInvalid: false, resHeaders: null, resHeadersState: 'unavailable', resBody: null, resBodyState: 'unavailable', resBytes: null, resCapturedBytes: null, resLimit: null,
          startMs: tsMs, headersMs: null, bodyMs: null, endMs: null, outcome: 'pending', error: null, errorPhase: null,
          retryOf: e.retryOf || null, retryReason: e.retryReason || null, traceId: e.traceId || null, spanId: e.spanId || null, native: e.native || null, note: e.note || null, events: [rawEv], line,
        };
        s.exchanges.push(x); s.exMap.set(x.id, x);
        break;
      }
      case 'response.headers': {
        const x = s.exMap.get(e.reqId);
        if (!x) { diagnostics.push({ line, severity: 'warning', code: 'orphan_response', message: `response.headers for unknown request "${e.reqId}"; ignored.` }); break; }
        x.events.push(rawEv);
        if (e.statusInvalid) { x.statusInvalid = true; break; }
        x.status = typeof e.status === 'number' ? e.status : null; x.statusText = e.statusText || statusText(x.status);
        x.headersMs = tsMs; x.resHeaders = Array.isArray(e.headers) ? e.headers : null; x.resHeadersState = Array.isArray(e.headers) ? 'captured' : 'unavailable';
        break;
      }
      case 'response.body': {
        const x = s.exMap.get(e.reqId);
        if (!x) { diagnostics.push({ line, severity: 'warning', code: 'orphan_body', message: `response.body for unknown request "${e.reqId}"; ignored.` }); break; }
        x.events.push(rawEv); x.bodyMs = tsMs; x.resBody = typeof e.body === 'string' ? e.body : null; x.resBodyState = e.bodyState || (x.resBody != null ? 'captured' : 'unavailable'); x.resBytes = e.bytes ?? null; x.resCapturedBytes = e.capturedBytes ?? null; x.resLimit = e.limit ?? null;
        break;
      }
      case 'request.end': {
        const x = s.exMap.get(e.reqId);
        if (!x) { diagnostics.push({ line, severity: 'warning', code: 'orphan_end', message: `request.end for unknown request "${e.reqId}"; ignored.` }); break; }
        x.events.push(rawEv); x.endMs = tsMs; x.outcome = e.outcome || 'unknown'; x.outcomeRaw = e.outcomeRaw || null; x.error = e.error || null; x.errorPhase = e.phase || null;
        if (typeof e.status === 'number' && x.status == null) { x.status = e.status; x.statusText = statusText(e.status); x.resHeadersState = x.resHeadersState === 'unavailable' ? 'not_recorded' : x.resHeadersState; }
        break;
      }
    }
  });
  // Finalize
  const out = [];
  sessions.forEach((s) => {
    s.operations.forEach((op) => { if (op.parentId) { const p = s.opMap.get(op.parentId); if (p) p.children.push(op); else op.parentMissing = true; } });
    s.exchanges.forEach((x) => {
      if (x.opId) { const op = s.opMap.get(x.opId); if (op) { op.exchanges.push(x); if (!x.component) x.component = op.component; } else x.opMissing = true; }
      const rec = x.recordingId ? s.recMap.get(x.recordingId) : null;
      if (x.outcome === 'pending') {
        if (rec && !rec.interrupted) { x.outcome = 'unknown'; x.note = (x.note ? x.note + ' · ' : '') + 'Observation stopped while the request was in flight; completion outcome not observed.'; }
        else x.outcome = 'unfinished';
      }
      const op = x.opId ? s.opMap.get(x.opId) : null;
      x.returnedEarly = !!(op && op.endMs != null && x.endMs != null && op.endMs < x.endMs);
      x.retryOfMissing = !!(x.retryOf && !s.exMap.has(x.retryOf));
    });
    s.exchanges.forEach((x) => { x.retriedBy = s.exchanges.filter((y) => y.retryOf === x.id).map((y) => y.id); });
    if (!s.explicitStart) diagnostics.push({ line: s.firstLine, severity: 'warning', code: 'implicit_session', message: `Session "${s.id}" has events but no session.start.` });
    s.recordings.forEach((r) => { if (r.interrupted) diagnostics.push({ line: r.line, severity: 'info', code: 'interrupted_recording', message: `Recording ${r.id} (session ${s.id}) has no recording.stop — the file ended or export was interrupted. In-flight requests are shown as unfinished, not failed.` }); });
    const counts = { total: s.exchanges.length, success: 0, http_error: 0, transport_failure: 0, timeout: 0, cancelled: 0, unknown: 0, unfinished: 0 };
    s.exchanges.forEach((x) => { counts[x.outcome] = (counts[x.outcome] || 0) + 1; });
    const origins = []; s.exchanges.forEach((x) => { if (!origins.includes(x.origin)) origins.push(x.origin); });
    const handlers = s.operations.filter((o) => o.invocation);
    counts.handlerCalls = handlers.length; counts.unfinishedHandlerCalls = handlers.filter((o) => o.endMs == null).length; counts.unknownHandlerOutcomes = handlers.filter((o) => o.completion === 'observation_stopped').length;
    const startMs = s.started ?? Math.min(...s.exchanges.map((x) => x.startMs ?? Infinity), ...s.recordings.map((r) => r.startMs ?? Infinity));
    const endCandidates = [s.ended, ...s.exchanges.map((x) => x.endMs), ...s.recordings.map((r) => r.stopMs)].filter((v) => v != null);
    out.push({ ...s, counts, origins, startMs: Number.isFinite(startMs) ? startMs : null, endMs: endCandidates.length ? Math.max(...endCandidates) : null, incomplete: s.recordings.some((r) => r.interrupted) || s.ended == null, recMap: undefined, opMap: undefined, exMap: undefined });
  });
  return { sessions: out, diagnostics };
}

export function importText(name, text) {
  const parsed = parseNdjson(text);
  const rec = reconstruct(parsed);
  const bytes = new TextEncoder().encode(text).length;
  const errors = rec.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = rec.diagnostics.filter((d) => d.severity === 'warning').length;
  return { name, bytes, lineCount: parsed.lineCount, eventCount: parsed.events.length, sessions: rec.sessions, diagnostics: rec.diagnostics, errors, warnings, status: errors ? 'errors' : warnings ? 'warnings' : 'ok' };
}

// Presentation helpers (pure)
export const OUTCOME_META = {
  success: { label: 'Success', glyph: '✓', tone: 'ok', desc: 'Response received and transfer completed.' },
  http_error: { label: 'HTTP error', glyph: '✕', tone: 'error', desc: 'Server answered with an error status.' },
  transport_failure: { label: 'Transport failure', glyph: '⚠', tone: 'error', desc: 'Connection or protocol failure before/without an HTTP response.' },
  timeout: { label: 'Timeout', glyph: '◷', tone: 'error', desc: 'Client gave up waiting.' },
  cancelled: { label: 'Cancelled', glyph: '⊘', tone: 'neutral', desc: 'Cancelled by the caller.' },
  unknown: { label: 'Unknown outcome', glyph: '?', tone: 'warn', desc: 'Observation stopped before completion.' },
  unfinished: { label: 'Unfinished capture', glyph: '…', tone: 'warn', desc: 'Recording was interrupted; the request may have completed.' },
  pending: { label: 'Pending', glyph: '→', tone: 'neutral', desc: '' },
};
export const COMPLETION_META = {
  returned: { label: 'Returned', glyph: '↩', tone: 'ok', desc: 'Normal method return to the caller. Says nothing about the returned business value.' },
  threw: { label: 'Threw', glyph: '↯', tone: 'error', desc: 'An exception unwound to the caller; the caller may have caught it.' },
  cancelled: { label: 'Cancelled', glyph: '⊘', tone: 'neutral', desc: 'Observed cancellation exit.' },
  observation_stopped: { label: 'Observation stopped', glyph: '?', tone: 'warn', desc: 'Method exit was not observed; no return is drawn.' },
  missing: { label: 'No end recorded', glyph: '…', tone: 'warn', desc: 'No operation end event; no return is drawn.' },
};
export const STATE_LABEL = { captured: 'Captured', partial: 'Partial', truncated: 'Truncated', redacted: 'Redacted', unavailable: 'Unavailable', not_recorded: 'Not recorded', not_applicable: 'Not applicable' };

export function fmtBytes(n) { if (n == null) return '—'; if (n < 1024) return `${n} B`; return `${(n / 1024).toFixed(1)} KB`; }
export function fmtMs(n) { if (n == null) return null; if (n < 1000) return `${Math.round(n)} ms`; return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`; }
export function fmtTime(ms) { if (ms == null) return 'not recorded'; const d = new Date(ms); return d.toISOString().slice(11, 23) + 'Z'; }
export function fmtClock(ms) { if (ms == null) return '—'; return new Date(ms).toISOString().slice(11, 19) + 'Z'; }
export function prettyJson(text) { try { const v = JSON.parse(text); return { ok: true, text: JSON.stringify(v, null, 2) }; } catch (e) { return { ok: false, text }; } }
