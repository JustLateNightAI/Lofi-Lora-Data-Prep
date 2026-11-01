const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { normalizeConfig, caption } = require('../lib/vision');
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
  assert.equal(body.max_tokens, 512); assert.equal(body.temperature, undefined); assert.equal(request.redirect, 'error');
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
  assert.equal(normalizeConfig({ temperature: 0 }).temperature, 0);
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
test('no insecure fallback stores keys in plaintext, and endpoint changes clear keys', async t => {
  const { root } = await fixture(t);
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' };
  const settings = new Settings(root, storage);
  await settings.saveApi({ baseURL: 'https://host.example/v1', model: 'vision', apiKey: 'fake-key', rememberKey: true });
  assert.equal(settings.public().remembered, false); assert.equal(settings.public().hasKey, true);
  assert.ok(!(await fs.readFile(settings.file, 'utf8')).includes('fake-key'));
  await settings.saveApi({ baseURL: 'https://other.example/v1', model: 'vision' }); assert.equal(settings.public().hasKey, false);
});
