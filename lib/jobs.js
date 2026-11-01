const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJson, digest } = require('../actions/transactions');
class CaptionJobs {
  constructor(directory, { generate, saveCaption, validateImage, getKey, notify = () => {} }) {
    Object.assign(this, { directory, generate, saveCaption, validateImage, getKey, notify });
    this.current = null; this.running = false; this.controller = null; this.work = Promise.resolve();
  }
  snapshot() { return this.current ? structuredClone({ ...this.current, running: this.running }) : null; }
  async persist() {
    await fs.mkdir(this.directory, { recursive: true });
    await writeJson(path.join(this.directory, `${this.current.id}.json`), this.current);
    this.notify(this.snapshot());
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    const files = (await fs.readdir(this.directory)).filter(n => n.endsWith('.json')).sort();
    if (!files.length) return;
    this.current = JSON.parse(await fs.readFile(path.join(this.directory, files.at(-1)), 'utf8'));
    if (this.current.status === 'running') {
      this.current.status = 'paused';
      for (const item of this.current.items) if (item.status === 'running') item.status = 'pending';
      await this.persist();
    }
  }
  async start(items, config, mode) {
    if (this.running) throw new Error('A caption job is already running.');
    if (!['missing', 'review', 'replace'].includes(mode)) throw new Error('Invalid caption save mode.');
    if (!config.model) throw new Error('Save a vision model name in API settings first.');
    if (this.current?.items.some(i => i.status === 'review')) throw new Error('Save or discard the pending caption reviews first.');
    if (!items.length) throw new Error('No images selected.');
    const planned = [];
    for (const item of items) {
      if (item.ambiguous) throw new Error(`Ambiguous caption stem: ${item.filename}`);
      planned.push({ ...item, imageHash: await digest(item.imagePath), captionHash: await digest(item.captionPath), status: 'pending' });
    }
    this.current = { id: `${Date.now()}-${crypto.randomUUID()}`, created: new Date().toISOString(), config: structuredClone(config), mode, status: 'paused', items: planned };
    await this.persist();
    return this.resume();
  }
  async resume(config) {
    if (!this.current || this.running) throw new Error('No paused job to resume.');
    const nextConfig = config || this.current.config;
    if (!nextConfig.model) throw new Error('Choose a vision model in API settings first.');
    const key = this.getKey(nextConfig.baseURL);
    this.current.config = structuredClone(nextConfig);
    delete this.current.pauseReason;
    for (const item of this.current.items) if (['failed', 'cancelled'].includes(item.status)) item.status = 'pending';
    this.controller = new AbortController(); this.running = true; this.current.status = 'running';
    try { await this.persist(); } catch (e) { this.running = false; throw e; }
    this.work = this.run(key).catch(async () => {
      this.current.status = 'paused'; this.running = false;
      this.notify(this.snapshot());
    });
    return this.snapshot();
  }
  async run(key) {
    try {
      for (const item of this.current.items) {
        if (this.controller.signal.aborted) break;
        if (item.status !== 'pending') continue;
        try {
          await this.validateImage(item.imagePath);
          if (await digest(item.imagePath) !== item.imageHash) throw new Error('Image changed since this job was created. Start a new job.');
          if (this.current.mode === 'missing' && await digest(item.captionPath) !== null) { item.status = 'skipped'; await this.persist(); continue; }
          item.status = 'running'; delete item.error; await this.persist();
          // Persist a generated caption before saving. Resume can reuse it without another API charge.
          if (!item.text) item.text = await this.generate(item.imagePath, this.current.config, key, this.controller.signal);
          this.controller.signal.throwIfAborted();
          await this.persist();
          if (this.current.mode === 'review') item.status = 'review';
          else {
            await this.saveCaption(item, item.text);
            item.status = 'completed';
          }
        } catch (e) {
          item.status = this.controller.signal.aborted ? 'cancelled' : 'failed';
          item.error = this.controller.signal.aborted ? 'Cancelled; completed captions were kept.' : e.message;
          if (!this.controller.signal.aborted && e.pauseJob) {
            this.current.pauseReason = item.error;
            break;
          }
        }
        await this.persist();
      }
      this.current.status = this.controller.signal.aborted || this.current.pauseReason ? 'paused' : this.current.items.some(i => i.status === 'failed') ? 'failed' : 'complete';
    } finally { this.running = false; await this.persist(); }
  }
  cancel() { this.controller?.abort(); return this.snapshot(); }
  async review(imagePath, text) {
    if (this.running) throw new Error('Wait for the job to finish before reviewing.');
    const item = this.current?.items.find(i => i.imagePath === imagePath && i.status === 'review');
    if (!item) throw new Error('No pending caption for this image.');
    if (text === null) item.status = 'discarded';
    else { await this.validateImage(item.imagePath); await this.saveCaption(item, text); item.status = 'completed'; }
    await this.persist(); return this.snapshot();
  }
}
module.exports = { CaptionJobs };
