const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants, createReadStream } = require('node:fs');
async function digest(file) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile()) throw new Error(`Not a regular file: ${file}`);
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function syncFile(file) {
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await syncFile(temp);
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
// Publish complete bytes without replacing an existing destination, even on another drive.
async function publish(source, target) {
  const temp = path.join(path.dirname(target), `.ldp-${crypto.randomUUID()}.tmp`);
  try {
    await fs.copyFile(source, temp, constants.COPYFILE_EXCL);
    await syncFile(temp);
    try { await fs.link(temp, target); }
    catch (e) {
      if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(e.code)) throw new Error(`Safe file publication requires NTFS or a Linux filesystem: ${target}`);
      throw e;
    }
  } finally { await fs.rm(temp, { force: true }); }
}
class Transactions {
  constructor(directory) { this.directory = directory; this.tail = Promise.resolve(); }
  exclusive(fn) {
    const work = this.tail.then(fn);
    this.tail = work.catch(() => {});
    return work;
  }
  async records() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.directory, entry.name, 'journal.json');
      try { records.push({ file, data: JSON.parse(await fs.readFile(file, 'utf8')) }); }
      catch (e) { if (e.code !== 'ENOENT') throw new Error(`Unreadable recovery journal: ${file}`); }
    }
    return records.sort((a, b) => a.data.created - b.data.created || a.data.id.localeCompare(b.data.id));
  }
  async restore(record) {
    const { data, file } = record;
    for (const entry of data.entries) {
      const current = await digest(entry.target);
      if (current !== null && current !== entry.beforeHash && current !== entry.afterHash) throw new Error(`Recovery conflict; file changed outside the app: ${entry.target}. Backups: ${path.dirname(file)}`);
      if (entry.beforeHash && await digest(entry.before) !== entry.beforeHash) throw new Error(`Recovery backup missing or damaged: ${entry.before}`);
    }
    for (const entry of data.entries) {
      const current = await digest(entry.target);
      if (current === entry.beforeHash) continue;
      if (current !== null) {
        if (current !== entry.afterHash) throw new Error(`File changed during recovery: ${entry.target}`);
        await fs.unlink(entry.target);
      }
      if (entry.beforeHash) await publish(entry.before, entry.target);
    }
    data.status = 'restored';
    await writeJson(file, data);
  }
  async recoverPending() {
    for (const record of await this.records()) if (['applying', 'undoing'].includes(record.data.status)) await this.restore(record);
  }
  recover() { return this.exclusive(() => this.recoverPending()); }
  execute(kind, changes) {
    return this.exclusive(async () => {
      await this.recoverPending();
      if (!changes.length) return { ok: true, changed: 0 };
      const id = crypto.randomUUID();
      const dir = path.join(this.directory, id);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const record = { file: path.join(dir, 'journal.json'), data: { id, kind, created: Date.now(), status: 'preparing', entries: [] } };
      const seen = new Set();
      try {
        for (const [index, change] of changes.entries()) {
          const target = path.resolve(change.target);
          const key = target.toLowerCase();
          if (seen.has(key)) throw new Error(`Duplicate destination: ${target}`);
          seen.add(key);
          const beforeHash = await digest(target);
          if (change.expected !== undefined && beforeHash !== change.expected) throw new Error(`File changed or target exists; refresh and try again: ${target}`);
          if (beforeHash === null) {
            const siblings = await fs.readdir(path.dirname(target));
            if (siblings.some(n => n.toLowerCase() === path.basename(target).toLowerCase())) throw new Error(`Target exists: ${target}`);
          }
          if (beforeHash && !change.replace) throw new Error(`Target exists: ${target}`);
          const before = path.join(dir, `${index}.before`);
          const after = path.join(dir, `${index}.after`);
          if (beforeHash) {
            await fs.copyFile(target, before, constants.COPYFILE_EXCL);
            await syncFile(before);
            if (await digest(before) !== beforeHash) throw new Error(`File changed while backing up: ${target}`);
          }
          if (!change.remove) {
            if (change.source) await fs.copyFile(change.source, after, constants.COPYFILE_EXCL);
            else if (change.render) await change.render(after);
            else await fs.writeFile(after, change.content, { flag: 'wx' });
            await syncFile(after);
          }
          record.data.entries.push({ target, before, after, beforeHash, afterHash: change.remove ? null : await digest(after) });
        }
        for (const entry of record.data.entries) if (await digest(entry.target) !== entry.beforeHash) throw new Error(`File changed before operation: ${entry.target}`);
        record.data.status = 'applying';
        await writeJson(record.file, record.data);
        for (const entry of record.data.entries) {
          if (await digest(entry.target) !== entry.beforeHash) throw new Error(`File changed during operation: ${entry.target}`);
          if (entry.beforeHash) await fs.unlink(entry.target);
          if (entry.afterHash) await publish(entry.after, entry.target);
        }
        record.data.status = 'complete';
        await writeJson(record.file, record.data);
        return { ok: true, changed: changes.length, operationId: id };
      } catch (error) {
        if (record.data.status === 'applying') {
          try { await this.restore(record); }
          catch (recovery) { throw new Error(`${error.message}\n${recovery.message}`); }
        } else if (record.data.status === 'preparing') await fs.rm(dir, { recursive: true, force: true });
        throw error;
      }
    });
  }
  undo() {
    return this.exclusive(async () => {
      await this.recoverPending();
      const record = (await this.records()).filter(r => r.data.status === 'complete').at(-1);
      if (!record) return { ok: true, message: 'Nothing to undo.' };
      for (const entry of record.data.entries) if (await digest(entry.target) !== entry.afterHash) throw new Error(`Cannot undo: file changed since ${record.data.kind}: ${entry.target}`);
      record.data.status = 'undoing';
      await writeJson(record.file, record.data);
      await this.restore(record);
      return { ok: true, message: `Undid ${record.data.kind}.` };
    });
  }
}
module.exports = { Transactions, digest, writeJson };
