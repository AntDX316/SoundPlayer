const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const root = path.join(__dirname, '..');
(async () => {
 const baseline = process.argv[2] || 'HEAD';
 const oldCode = execFileSync('git', ['show', baseline + ':app.js'], { cwd: root, encoding: 'utf8' });
 const newCode = await fs.readFile(path.join(root, 'app.js'), 'utf8');
 const results = [];
 for (const [variant, code] of [['before', oldCode], ['after', newCode]]) {
  for (let trial = 0; trial < 3; trial++) {
   const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'soundplayer-benchmark-'));
   const app = await electron.launch({ args: [path.join(root, 'main.js')], env: { ...process.env, SOUNDPLAYER_TEST_PROFILE: profile } });
   try {
    const page = await app.firstWindow(); await page.waitForFunction(() => window.soundPlayer?.ready); await page.evaluate(() => soundPlayer.ready);
    await page.evaluate(async () => {
     const tx = soundPlayer.db.transaction(['files','state'], 'readwrite');
     const buffer = new ArrayBuffer(1024 * 1024), files = [];
     for (let i = 0; i < 64; i++) { const id = 'track-' + i; tx.objectStore('files').put(buffer, id); files.push({ id, name: id + '.wav' }); }
     tx.objectStore('state').put({ files, folders: [{ id: 'all', name: 'All Files', files: files.map(f => f.id) }], currentFolder:'all' }, 'currentState');
     await new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onerror=reject; });
    });
    const result = await page.evaluate(async code => {
     const source = code.replace('class SoundPlayer', 'window.BenchmarkPlayer = class SoundPlayer');
     (0,eval)(source);
     let bytesRead=0, reads=0;
     const get=IDBObjectStore.prototype.get;
     IDBObjectStore.prototype.get=function(...args) { const request=get.apply(this,args); if(this.name==='files') { reads++; request.addEventListener('success',()=> { bytesRead+=request.result?.byteLength || request.result?.size || 0; }); } return request; };
     const original=BenchmarkPlayer.prototype.loadState;
     let complete;
     const done=new Promise(resolve=>complete=resolve);
     BenchmarkPlayer.prototype.loadState=async function() { const start=performance.now(); await original.call(this); complete({milliseconds:performance.now()-start,reads,bytesRead,objectURLs:this.activeObjectURLs.size}); };
     new BenchmarkPlayer();
     const result=await done; IDBObjectStore.prototype.get=get; return result;
    }, code);
    results.push({variant,trial,...result});
   } finally { await app.close(); await fs.rm(profile,{recursive:true,force:true}); }
  }
 }
 console.log(JSON.stringify({baseline,tracks:64,libraryMiB:64,runtime:require('electron/package.json').version,results},null,2));
})().catch(error=>{ console.error(error); process.exitCode=1; });
