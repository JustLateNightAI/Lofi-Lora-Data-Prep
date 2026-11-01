const fs = require('node:fs/promises');
const path = require('node:path');
const { writeJson } = require('../actions/transactions');
const { normalizeConfig } = require('./vision');
class Settings {
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'settings.json'); this.safeStorage = safeStorage;
    this.value = { api: normalizeConfig(), roots: [], inputDir: null, outputDir: null, secret: null };
    this.key = ''; this.tail = Promise.resolve();
  }
  canEncrypt() { return this.safeStorage.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
  async load() {
    try { this.value = { ...this.value, ...JSON.parse(await fs.readFile(this.file, 'utf8')) }; }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('Settings could not be read. Preserve settings.json before repairing it.'); }
    this.value.api = normalizeConfig(this.value.api);
    if (this.value.secret && this.canEncrypt()) {
      try { this.key = this.safeStorage.decryptString(Buffer.from(this.value.secret, 'base64')); } catch { this.key = ''; }
    }
    return this.public();
  }
  persist() {
    const snapshot = structuredClone(this.value);
    const work = this.tail.then(() => writeJson(this.file, snapshot));
    this.tail = work.catch(() => {}); return work;
  }
  public() { const { secret, ...rest } = this.value; return { ...rest, hasKey: !!this.key, remembered: !!secret, canRememberKey: this.canEncrypt() }; }
  async saveApi(input) {
    const api = normalizeConfig(input);
    if (api.baseURL !== this.value.api.baseURL || input.forgetKey) { this.key = ''; this.value.secret = null; }
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) this.key = input.apiKey.trim();
    if (input.rememberKey && this.key && this.canEncrypt()) this.value.secret = this.safeStorage.encryptString(this.key).toString('base64');
    else this.value.secret = null;
    this.value.api = api; await this.persist(); return this.public();
  }
  keyFor(baseURL) {
    if (baseURL !== this.value.api.baseURL) throw new Error('Restore the job’s API endpoint before resuming it.');
    return this.key;
  }
  requestKey(baseURL, providedKey) {
    if (typeof providedKey === 'string' && providedKey.trim()) return providedKey.trim();
    return baseURL === this.value.api.baseURL ? this.key : '';
  }
}
module.exports = { Settings };
