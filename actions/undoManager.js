const fse = require('fs-extra');

const stack = [];

module.exports = {
  push(s) { stack.push(s); },
  async undo() {
    const s = stack.pop();
    if (!s) return { ok:true, message:'Nothing to undo.' };

    if (s.type === 'batchRename') {
      // reverse in-place renames (walk in reverse)
      if (Array.isArray(s.renames) && s.renames.length) {
        for (let i = s.renames.length - 1; i >= 0; i--) {
          const { from, to } = s.renames[i];
          try {
            if (await fse.pathExists(from)) await fse.move(from, to, { overwrite: true });
          } catch (_) {}
        }
      }
      if (Array.isArray(s.tagRenames) && s.tagRenames.length) {
        for (let i = s.tagRenames.length - 1; i >= 0; i--) {
          const { from, to } = s.tagRenames[i];
          try {
            if (await fse.pathExists(from)) await fse.move(from, to, { overwrite: true });
          } catch (_) {}
        }
      }
      // delete files created during copy-mode
      if (Array.isArray(s.created)) {
        for (const p of s.created) { try { await fse.remove(p); } catch (_) {} }
      }
      if (Array.isArray(s.tagCreated)) {
        for (const p of s.tagCreated) { try { await fse.remove(p); } catch (_) {} }
      }
      return { ok:true, message:'Undo: batchRename restored.' };
    }

    if (s.type === 'delete') {
      for (const r of s.restores) {
        try { if (await fse.pathExists(r.trashImg)) await fse.move(r.trashImg, r.finalImg, { overwrite: true }); } catch (_) {}
        if (r.trashTag && r.finalTag) {
          try { if (await fse.pathExists(r.trashTag)) await fse.move(r.trashTag, r.finalTag, { overwrite: true }); } catch (_) {}
        }
      }
      return { ok:true, message:'Undo: deletes restored.' };
    }

    return { ok:true, message:'Undo: unknown snapshot type.' };
  }
};
