import { createFetchClient } from '#logger';
export const sdkActor = { owner: 'sdk', component: 'DemoAuthSDK', method: 'signIn' };
export const appActor = { owner: 'integrator', component: 'DemoApp', method: 'provideProof' };
export async function signIn(session, handler) {
  const operation = session.startOperation({ name: 'DemoAuthSDK.signIn', origin: sdkActor });
  const client = createFetchClient(session, { origin: { initiator: sdkActor, executor: sdkActor }, parent: operation.context });
  async function json(url, init) { return client.readJson(await client.fetch(url, init)); }
  const post = data => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const challenge = await json('http://127.0.0.1:4181/challenge', post({ user: 'demo' }));
    const proof = await session.invokeAsyncHandler({ name: 'App provides proof', origin: appActor, caller: sdkActor, parent: operation.context }, context => handler(challenge, context));
    await json('http://127.0.0.1:4181/token', post({ proof, password: 'SAMPLE_PASSWORD_SENTINEL' }));
    const expired = await client.fetch('http://127.0.0.1:4182/profile', { headers: { Authorization: 'Bearer expired' } });
    await client.readJson(expired);
    if (expired.status !== 401) throw new Error('Expected demo expiry');
    const refreshed = await json('http://127.0.0.1:4181/refresh', post({ refresh_token: 'SAMPLE_REFRESH_SENTINEL' }));
    const profile = await json('http://127.0.0.1:4182/profile', { headers: { Authorization: `Bearer ${refreshed.access_token}` } });
    operation.end(); return profile;
  } catch (error) { operation.end('error', error); throw error; }
}
