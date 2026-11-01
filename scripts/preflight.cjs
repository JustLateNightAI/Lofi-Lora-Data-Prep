const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('Node.js 22.12+ is required. Install Node.js 24 LTS, then rerun setup.');
  process.exitCode = 1;
} else console.log(`Node ${process.versions.node}: ready. Python and CUDA are not required.`);
