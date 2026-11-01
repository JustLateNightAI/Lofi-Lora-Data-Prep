const { Transactions } = require('./transactions');
let manager;
module.exports = {
  configure(directory) { manager = new Transactions(directory); return manager; },
  get() { if (!manager) throw new Error('History has not been initialized.'); return manager; },
  undo() { return this.get().undo(); }
};
