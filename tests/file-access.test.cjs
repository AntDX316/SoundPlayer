const test = require('node:test');
const assert = require('node:assert/strict');
const { FileAccess } = require('../file-access');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
test('file access requires native grants and atomic ZIP replacement preserves payload', async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soundplayer-access-'));
 try {
  const file = path.join(directory, 'library.zip'), gate = new FileAccess();
  await assert.rejects(gate.write(file, Buffer.from('new')), /Save dialog/);
  await assert.rejects(gate.read(file), /Open dialog/);
  assert.throws(() => gate.grant(path.join(directory, 'app.exe'), 'write'), /ZIP/);
  gate.grant(file, 'write'); await gate.write(file, Buffer.from('original')); await gate.write(file, Buffer.from('replacement'));
  gate.grant(file, 'read'); assert.equal((await gate.read(file)).toString(), 'replacement');
  assert.deepEqual(await fs.readdir(directory), ['library.zip']);
 } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
