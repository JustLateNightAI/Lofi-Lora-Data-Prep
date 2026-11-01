const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { normalizeBaseURL, normalizeConfig, listModels, caption } = require('../lib/vision');
const { CaptionJobs } = require('../lib/jobs');
const { Settings } = require('../lib/settings');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lofi-vision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'image.png');
  await sharp({ create: { width: 4, height: 3, channels: 3, background: 'red' } }).png().toFile(imagePath);
  return { root, item: { imagePath, captionPath: path.join(root, 'image.txt'), filename: 'image.png' } };
}
test('vision request sends image bytes and honors configured model/token options', async t => {
  const { item } = await fixture(t); let request;
  const config = normalizeConfig({ baseURL: 'http://localhost:1234/v1/', model: 'vision-model', tokenField: 'max_tokens', temperature: '' });
  const result = await caption(item.imagePath, config, 'synthetic-key', new AbortController().signal, async (url, options) => {
    request = { url, ...options }; return Response.json({ choices: [{ message: { content: 'A red rectangle.' }, finish_reason: 'stop' }] });
  });
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'http://localhost:1234/v1/chat/completions'); assert.equal(body.model, 'vision-model');
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(body.max_tokens, 2048); assert.equal(body.temperature, undefined); assert.equal(body.reasoning_effort, undefined); assert.equal(request.redirect, 'error');
  assert.equal(result, 'A red rectangle.');
});
test('API errors do not persist echoed secrets and truncated text is not accepted', async t => {
  const { item } = await fixture(t), config = normalizeConfig({ model: 'vision' });
  await assert.rejects(caption(item.imagePath, config, 'secret', null, async () => Response.json({ error: 'secret' }, { status: 401 })), /^Error: API HTTP 401/);
  await assert.rejects(caption(item.imagePath, config, '', null, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })), /truncated/);
});
test('unsafe endpoints and invalid options are rejected', () => {
  for (const baseURL of ['http://example.com/v1', 'file:///etc/passwd', 'https://key@host/v1', 'https://host/v1?key=secret']) assert.throws(() => normalizeConfig({ baseURL }));
  assert.throws(() => normalizeConfig({ temperature: 'NaN' }));
  assert.throws(() => normalizeConfig({ reasoningEffort: 'invalid' }));
  assert.throws(() => normalizeConfig({ maxTokens: 65537 }));
  assert.equal(normalizeConfig({ maxTokens: 32768 }).maxTokens, 32768);
  assert.equal(normalizeConfig({ temperature: 0 }).temperature, 0);
});
test('thinking controls are sent explicitly and reasoning never becomes a caption', async t => {
  const { item } = await fixture(t);
  for (const reasoningEffort of ['none', 'low']) {
    const config = normalizeConfig({ model: 'vision', reasoningEffort });
    assert.equal(await caption(item.imagePath, config, '', null, async (_url, options) => {
      assert.equal(JSON.parse(options.body).reasoning_effort, reasoningEffort);
      return Response.json({ choices: [{ message: { reasoning_content: 'internal notes', content: '<think>more internal notes</think>A red rectangle.' }, finish_reason: 'stop' }] });
    }), 'A red rectangle.');
    for (const content of [null, '<think>unfinished reasoning', 'unseparated reasoning</think>A red rectangle.']) {
      await assert.rejects(caption(item.imagePath, config, '', null, async () => Response.json({ choices: [{ message: { reasoning_content: 'internal notes', content }, finish_reason: 'stop' }] })), e => e.pauseJob && e.code === 'NO_CAPTION');
    }
  }
});
test('connection errors and token exhaustion pause safely without exposing provider text', async t => {
  const { item } = await fixture(t), config = normalizeConfig({ model: 'vision', maxTokens: 512 });
  await assert.rejects(caption(item.imagePath, config, 'secret', null, async () => { throw new Error('secret'); }), e => e.pauseJob && e.code === 'API_UNAVAILABLE' && !e.message.includes('secret'));
  for (const status of [400, 401, 429, 500, 503]) {
    await assert.rejects(caption(item.imagePath, config, 'secret', null, async () => Response.json({ error: 'secret' }, { status })), e => e.pauseJob && e.code === 'API_HTTP' && !e.message.includes('secret'));
  }
  await assert.rejects(caption(item.imagePath, config, '', null, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'internal notes' } }], usage: { completion_tokens_details: { reasoning_tokens: 512 } } })), e => e.pauseJob && e.code === 'TOKEN_LIMIT' && e.message.includes('512 reasoning tokens') && !e.message.includes('internal notes'));
});
test('local endpoints accept bare LAN addresses and preserve custom API roots', () => {
  assert.equal(normalizeBaseURL('192.168.1.2:8000'), 'http://192.168.1.2:8000/v1');
  assert.equal(normalizeBaseURL('http://10.0.0.2:1234/'), 'http://10.0.0.2:1234/v1');
  assert.equal(normalizeBaseURL('http://172.16.2.3:8000/custom/'), 'http://172.16.2.3:8000/custom');
  assert.equal(normalizeBaseURL('localhost:1234'), 'http://localhost:1234/v1');
  assert.equal(normalizeBaseURL('http://deepseek.local:8000'), 'http://deepseek.local:8000/v1');
  assert.equal(normalizeBaseURL('http://[fd00::2]:8000/v1'), 'http://[fd00::2]:8000/v1');
  assert.throws(() => normalizeBaseURL('http://172.32.1.2/v1'));
  assert.throws(() => normalizeBaseURL('http://192.168.1.2:8000/v1?key=secret'));
});
test('model discovery requests authenticated IDs and returns sorted unique choices', async () => {
  let request;
  const models = await listModels('192.168.1.2:8000', 'synthetic-key', async (url, options) => {
    request = { url, ...options };
    return Response.json({ data: [{ id: 'z-vision' }, { id: 'a-vision' }, { id: 'z-vision' }, { id: '' }, { name: 'invalid' }, null] });
  });
  assert.deepEqual(models, ['a-vision', 'z-vision']);
  assert.equal(request.url, 'http://192.168.1.2:8000/v1/models');
  assert.equal(request.method, 'GET'); assert.equal(request.headers.Authorization, 'Bearer synthetic-key');
  assert.equal(request.redirect, 'error'); assert.ok(request.signal);
  assert.deepEqual(await listModels('localhost:1234', '', async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined); return Response.json({ data: [] });
  }), []);
});
test('model discovery reports safe actionable errors for failed or malformed responses', async () => {
  await assert.rejects(listModels('localhost:1234', 'secret', async () => Response.json({ error: 'secret' }, { status: 401 })), /^Error: Models HTTP 401\. Check your API key\.$/);
  await assert.rejects(listModels('localhost:1234', '', async () => Response.json({ wrong: [] })), /unsupported model list/);
  await assert.rejects(listModels('localhost:1234', '', async () => new Response('not json')), /invalid JSON/);
  await assert.rejects(listModels('localhost:1234', '', async () => { throw new Error('secret'); }), /Could not reach the model list/);
});
test('missing-only job skips existing captions without contacting provider', async t => {
  const { root, item } = await fixture(t); await fs.writeFile(item.captionPath, 'existing'); let calls = 0;
  const jobs = new CaptionJobs(path.join(root, 'jobs'), { generate: async () => { calls++; }, saveCaption: async () => {}, validateImage: async () => {}, getKey: () => '' });
  await jobs.start([item], normalizeConfig({ model: 'vision' }), 'missing'); await jobs.work;
  assert.equal(calls, 0); assert.equal(jobs.current.items[0].status, 'skipped'); assert.equal(await fs.readFile(item.captionPath, 'utf8'), 'existing');
});
test('job review defers writes and survives restart', async t => {
  const { root, item } = await fixture(t); let saved;
  const options = { generate: async () => 'suggestion', saveCaption: async (_item, text) => { saved = text; }, validateImage: async () => {}, getKey: () => 'not-persisted' };
  const jobs = new CaptionJobs(path.join(root, 'jobs'), options);
  await jobs.start([item], normalizeConfig({ model: 'vision' }), 'review'); await jobs.work;
  assert.equal(saved, undefined); assert.equal(jobs.current.items[0].status, 'review');
  const restored = new CaptionJobs(path.join(root, 'jobs'), options); await restored.load();
  await restored.review(item.imagePath, 'edited suggestion'); assert.equal(saved, 'edited suggestion');
  const disk = await fs.readFile(path.join(root, 'jobs', `${jobs.current.id}.json`), 'utf8'); assert.ok(!disk.includes('not-persisted'));
});
test('cancel aborts the active request and resumes unfinished images', async t => {
  const { root, item } = await fixture(t); let started; const ready = new Promise(r => { started = r; }); let saved = 0;
  const jobs = new CaptionJobs(path.join(root, 'jobs'), { generate: async (_file, _config, _key, signal) => { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }, saveCaption: async () => { saved++; }, validateImage: async () => {}, getKey: () => '' });
  await jobs.start([item], normalizeConfig({ model: 'vision' }), 'missing'); await ready; jobs.cancel(); await jobs.work;
  assert.equal(saved, 0); assert.equal(jobs.current.status, 'paused'); jobs.generate = async () => 'caption'; await jobs.resume(); await jobs.work; assert.equal(saved, 1);
});
test('API failures pause the queue; resumed jobs use saved settings and keep completed captions', async t => {
  const { root, item } = await fixture(t);
  const { item: second } = await fixture(t), { item: third } = await fixture(t);
  const saved = [], requested = [];
  const options = { generate: async file => {
    requested.push(file);
    if (file === second.imagePath) throw Object.assign(new Error('Server unavailable'), { pauseJob: true });
    return 'first caption';
  }, saveCaption: async (image, text) => { saved.push([image.imagePath, text]); }, validateImage: async () => {}, getKey: () => '' };
  const jobs = new CaptionJobs(path.join(root, 'jobs'), options);
  await jobs.start([item, second, third], normalizeConfig({ model: 'vision', maxTokens: 512 }), 'missing'); await jobs.work;
  assert.equal(jobs.current.status, 'paused'); assert.equal(jobs.current.pauseReason, 'Server unavailable');
  assert.deepEqual(jobs.current.items.map(i => i.status), ['completed', 'failed', 'pending']);
  assert.deepEqual(requested, [item.imagePath, second.imagePath]);
  const restored = new CaptionJobs(path.join(root, 'jobs'), { ...options, generate: async (file, config) => {
    requested.push(file); assert.equal(config.maxTokens, 2048); assert.equal(config.reasoningEffort, 'none'); return 'retried caption';
  } });
  await restored.load(); await restored.resume(normalizeConfig({ model: 'vision', maxTokens: 2048, reasoningEffort: 'none' })); await restored.work;
  assert.equal(restored.current.status, 'complete'); assert.equal(restored.current.pauseReason, undefined);
  assert.deepEqual(requested, [item.imagePath, second.imagePath, second.imagePath, third.imagePath]);
  assert.deepEqual(saved, [[item.imagePath, 'first caption'], [second.imagePath, 'retried caption'], [third.imagePath, 'retried caption']]);
});
test('no insecure fallback stores keys in plaintext, and endpoint changes clear keys', async t => {
  const { root } = await fixture(t);
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' };
  const settings = new Settings(root, storage);
  await settings.saveApi({ baseURL: 'https://host.example/v1', model: 'vision', apiKey: 'fake-key', rememberKey: true });
  assert.equal(settings.public().remembered, false); assert.equal(settings.public().hasKey, true);
  assert.ok(!(await fs.readFile(settings.file, 'utf8')).includes('fake-key'));
  assert.equal(settings.requestKey('https://host.example/v1', ''), 'fake-key');
  assert.equal(settings.requestKey('http://192.168.1.2:8000/v1', ''), '');
  assert.equal(settings.requestKey('http://192.168.1.2:8000/v1', 'temporary-key'), 'temporary-key');
  assert.equal(settings.keyFor('https://host.example/v1'), 'fake-key');
  await settings.saveApi({ baseURL: 'https://other.example/v1', model: 'vision' }); assert.equal(settings.public().hasKey, false);
});
