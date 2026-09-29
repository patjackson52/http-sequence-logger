import { createFetchClient, observeXHR } from '#logger';
import { setup } from '#setup';
import { signIn, sdkActor, appActor } from './auth-sdk.mjs';
const tools = await setup(document.querySelector('#debug'));
const result = document.querySelector('#result');
async function run(work, name) { return tools.exclusive(async () => {
  const session = tools.logger.startSession({ name, sessionId: 'web-demo-session' });
  try { result.textContent = JSON.stringify(await work(session), null, 2); }
  catch (error) { result.textContent = `Application error: ${error.name}`; }
  finally { session.end(); await tools.afterRun(); }
}); }
document.querySelector('#run').onclick = () => run(session => signIn(session, (_challenge, parent) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest(); xhr.open('GET', 'http://127.0.0.1:4182/proof');
  const observer = observeXHR(session, xhr, () => ({ method: 'GET', url: 'http://127.0.0.1:4182/proof', body: null, origin: { initiator: sdkActor, executor: appActor }, parent }));
  xhr.addEventListener('load', () => { try { resolve(JSON.parse(xhr.responseText).proof); } catch (error) { reject(error); } });
  xhr.addEventListener('error', () => reject(new Error('Proof unavailable')));
  try { xhr.send(); } catch (error) { observer.dispose(); reject(error); }
})), 'Browser SDK auth with recovery');
document.querySelector('#public').onclick = () => run(async session => {
  const client = createFetchClient(session, { origin: { initiator: appActor, executor: appActor } });
  const results = [];
  for (const url of ['https://jsonplaceholder.typicode.com/todos/1', 'https://dummyjson.com/products/1']) {
    const response = await client.fetch(url); results.push({ status: response.status, data: await client.readJson(response) });
  }
  return results;
}, 'Public API browser capture');
