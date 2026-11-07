const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class FileAccess {
    constructor() { this.readable = new Set(); this.writable = new Set(); }
    grant(file, mode) {
        if (!file || path.extname(file).toLowerCase() !== '.zip') throw new Error('Choose a ZIP library');
        const target = path.resolve(file);
        (mode === 'read' ? this.readable : this.writable).add(target);
        return target;
    }
    async read(file) {
        const target = path.resolve(file);
        if (!this.readable.has(target)) throw new Error('Choose this library through the Open dialog first');
        if ((await fs.stat(target)).size > 2 * 1024 ** 3) throw new Error('Library archive exceeds 2 GB');
        return fs.readFile(target);
    }
    async write(file, data) {
        const target = path.resolve(file);
        if (!this.writable.has(target)) throw new Error('Choose this destination through the Save dialog first');
        const temporary = target + '.' + randomUUID() + '.tmp';
        try {
            await fs.writeFile(temporary, Buffer.from(data), { flag: 'wx' });
            await fs.rename(temporary, target);
            return true;
        } finally { await fs.rm(temporary, { force: true }); }
    }
}
module.exports = { FileAccess };
