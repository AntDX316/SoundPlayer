const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
let app, page, directory;
function wav(seconds = 2) {
    const rate = 8000, size = seconds * rate * 2, b = Buffer.alloc(44 + size);
    b.write('RIFF'); b.writeUInt32LE(size + 36, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40);
    for (let i = 0; i < size / 2; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 1000), 44 + i * 2);
    return b;
}
async function launch() {
    app = await electron.launch({ executablePath: process.env.SOUNDPLAYER_EXECUTABLE, args: process.env.SOUNDPLAYER_EXECUTABLE ? ['--mute-audio'] : [path.join(__dirname, '..', 'main.js'), '--mute-audio'], env: { ...process.env, SOUNDPLAYER_TEST_PROFILE: path.join(directory, 'profile') } });
    page = await app.firstWindow();
    page.on('dialog', dialog => dialog.accept());
    await page.waitForFunction(() => window.soundPlayer?.ready); await page.evaluate(() => window.soundPlayer.ready);
}
async function importTracks() {
    for (const name of ['one.wav', 'two.wav', 'three.wav']) await fs.writeFile(path.join(directory, name), wav(10));
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#fileUpload').click({ force: true });
    await (await chooser).setFiles(['one.wav', 'two.wav', 'three.wav'].map(name => path.join(directory, name)));
    await expect.poll(() => page.evaluate(() => window.soundPlayer.files.size)).toBe(3);
    await expect.poll(() => page.evaluate(() => !!window.soundPlayer.libraryBusy)).toBe(false);
}
test.beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soundplayer-test-')); await launch(); });
test.afterEach(async () => { await app?.close(); await fs.rm(directory, { recursive: true, force: true }); });

test('imports, plays, seeks, changes volume, searches and persists lazily', async () => {
    await importTracks();
    await page.evaluate(async () => { const p = window.soundPlayer; await p.playFile([...p.files.keys()][0]); });
    await expect.poll(() => page.evaluate(() => window.soundPlayer.isPlaying)).toBe(true);
    await page.evaluate(() => { const p = window.soundPlayer; p.setVolume(35); p.seek(50); p.pause(); });
    await expect.poll(() => page.evaluate(() => window.soundPlayer.audioElement.currentTime)).toBeGreaterThan(4);
    await page.evaluate(() => window.soundPlayer.saveState());
    await page.locator('#searchInput').fill('two');
    await expect(page.locator('.file-card')).toHaveCount(1);
    await page.reload(); await page.waitForFunction(() => window.soundPlayer?.ready); await page.evaluate(() => window.soundPlayer.ready);
    const state = await page.evaluate(() => ({ size: soundPlayer.files.size, urls: soundPlayer.activeObjectURLs.size, position: soundPlayer.resumePosition, volume: soundPlayer.audioElement.volume }));
    expect(state.size).toBe(3); expect(state.urls).toBe(0); expect(state.position).toBeGreaterThan(4); expect(state.volume).toBeCloseTo(.35);
    await page.locator('#playBtn').click({ force: true });
    await expect.poll(() => page.evaluate(() => soundPlayer.isPlaying)).toBe(true);
    await expect.poll(() => page.evaluate(() => soundPlayer.audioElement.currentTime)).toBeGreaterThan(4);
});

test('exports a portable ZIP and restores through native IPC', async () => {
    await importTracks(); const target = path.join(directory, 'library.zip');
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, target);
    await page.evaluate(() => soundPlayer.saveToFile());
    const zip = await JSZip.loadAsync(await fs.readFile(target));
    const metadata = JSON.parse(await zip.file('metadata.json').async('string'));
    expect(metadata.fileInfo).toHaveLength(3);
    expect(await zip.file(metadata.fileInfo[0].id).async('nodebuffer')).toEqual(wav(10));
    await page.evaluate(() => soundPlayer.loadFromFile());
    expect(await page.evaluate(() => soundPlayer.files.size)).toBe(3);
    await page.reload(); await page.evaluate(() => soundPlayer.ready);
    expect(await page.evaluate(() => soundPlayer.files.size)).toBe(3);
});

test('invalid or incomplete archives preserve the current library', async () => {
    await importTracks(); const target = path.join(directory, 'broken.zip');
    const zip = new JSZip(); zip.file('metadata.json', JSON.stringify({ folders: [], fileInfo: [{ id: 'missing', name: 'lost.wav' }] }));
    await fs.writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, target);
    const before = await page.evaluate(() => [...soundPlayer.files.keys()]);
    await page.evaluate(() => soundPlayer.loadFromFile());
    expect(await page.evaluate(() => [...soundPlayer.files.keys()])).toEqual(before);
    await page.reload(); await page.evaluate(() => soundPlayer.ready);
    expect(await page.evaluate(() => [...soundPlayer.files.keys()])).toEqual(before);
});

test('unselected paths are rejected and user names render as text', async () => {
    const result = await page.evaluate(async () => {
        try { await window.electronAPI.loadFile('C:/Windows/win.ini'); return false; } catch { return true; }
    }); expect(result).toBe(true);
    await page.evaluate(() => { soundPlayer.folders.set('test', { name: '<img src=x onerror="window.injected=true">', files: new Set() }); soundPlayer.updateFoldersList(); soundPlayer.handleSearch('<img src=x>'); });
    expect(await page.evaluate(() => !!window.injected)).toBe(false);
    await expect(page.locator('#folders img')).toHaveCount(0);
    await expect(page.locator('#folders')).toContainText('<img');
});

test('legacy ArrayBuffer libraries remain playable without eager audio reads', async () => {
    const bytes = [...wav(10)];
    await page.evaluate(async bytes => {
        const p = soundPlayer;
        await p.storeFile('legacy', new Uint8Array(bytes).buffer);
        p.files.set('legacy', { id: 'legacy', name: 'legacy.wav' }); p.folders.get('all').files.add('legacy'); await p.saveState();
    }, bytes);
    await page.reload(); await page.evaluate(() => soundPlayer.ready);
    expect(await page.evaluate(() => soundPlayer.activeObjectURLs.size)).toBe(0);
    await page.evaluate(() => soundPlayer.playFile('legacy'));
    await expect.poll(() => page.evaluate(() => soundPlayer.isPlaying)).toBe(true);
});

test('shuffle avoids repeats in a cycle and previous follows playback history', async () => {
    await importTracks();
    const sequence = await page.evaluate(async () => {
        const p = soundPlayer, ids = [...p.files.keys()], sequence = [ids[0]];
        await p.playFile(ids[0]);
        const original = p.playFile.bind(p);
        // Wait for async lazy reads before requesting the next track.
        p.playFile = async (...args) => { const result = await original(...args); sequence.push(p.currentTrack); return result; };
        p.playRandomTrack(); await new Promise(resolve => setTimeout(resolve, 100));
        p.playRandomTrack(); await new Promise(resolve => setTimeout(resolve, 100));
        const previous = sequence[1]; p.playPrevious(); await new Promise(resolve => setTimeout(resolve, 100));
        return { cycle: sequence.slice(0, 3), previous, actual: p.currentTrack };
    });
    expect(new Set(sequence.cycle).size).toBe(3); expect(sequence.actual).toBe(sequence.previous);
});


test('folders persist and clearing the library stays cleared after restart', async () => {
    await importTracks();
    await page.evaluate(async () => {
        const p = soundPlayer;
        p.folders.set('favorites', { name: 'Favorites', files: new Set([p.files.keys().next().value]) });
        p.switchFolder('favorites'); await p.saveState();
    });
    await page.reload(); await page.waitForFunction(() => window.soundPlayer?.ready); await page.evaluate(() => soundPlayer.ready);
    await expect(page.locator('#currentFolderName')).toHaveText('Favorites');
    await expect(page.locator('.file-card')).toHaveCount(1);
    await page.evaluate(() => soundPlayer.clearAll());
    await page.reload(); await page.waitForFunction(() => window.soundPlayer?.ready); await page.evaluate(() => soundPlayer.ready);
    expect(await page.evaluate(() => soundPlayer.files.size)).toBe(0);
});

test('cancelled staged restore preserves existing library and cleans temporary audio', async () => {
    await importTracks();
    const target = path.join(directory, 'cancel.zip'), zip = new JSZip();
    zip.file('metadata.json', JSON.stringify({folders: [], fileInfo: [{id:'new-one',name:'new-one.wav'},{id:'new-two',name:'new-two.wav'}]}));
    zip.file('new-one', wav()); zip.file('new-two', wav());
    await fs.writeFile(target, await zip.generateAsync({type:'nodebuffer'}));
    await app.evaluate(({dialog},target)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]});},target);
    const before = await page.evaluate(() => [...soundPlayer.files.keys()]);
    await page.evaluate(async () => {
        const p = soundPlayer, originalDialog = p.showLoadingDialog.bind(p), originalStore = p.storeFile.bind(p);
        let cancel;
        p.showLoadingDialog = async (...args) => { const dialog=await originalDialog(...args); cancel=()=>dialog.cancelBtn.click(); return dialog; };
        p.storeFile = async (...args) => { await originalStore(...args); cancel(); };
        await p.loadFromFile(); p.storeFile=originalStore; p.showLoadingDialog=originalDialog;
    });
    expect(await page.evaluate(() => [...soundPlayer.files.keys()])).toEqual(before);
    const keys = await page.evaluate(() => new Promise(resolve=>{const r=soundPlayer.db.transaction('files').objectStore('files').getAllKeys();r.onsuccess=()=>resolve(r.result);}));
    expect(keys.sort()).toEqual(before.sort());
});

test('packaged assets load offline without remote scripts', async () => {
    expect(await page.evaluate(() => typeof JSZip)).toBe('function');
    expect(await page.evaluate(() => [...document.scripts].every(s=>!s.src.startsWith('http')))).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('24px "Material Icons"'))).toBe(true);
});


test('failed export preserves an existing destination instead of writing a partial backup', async () => {
    await importTracks(); const target=path.join(directory,'existing.zip'); await fs.writeFile(target,'original-backup');
    await app.evaluate(({dialog},target)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:target});},target);
    await page.evaluate(async()=>{const p=soundPlayer,original=p.getFile.bind(p);p.getFile=async()=>undefined;await p.saveToFile();p.getFile=original;});
    expect((await fs.readFile(target)).toString()).toBe('original-backup');
});
