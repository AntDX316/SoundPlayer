const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const { pathToFileURL } = require('node:url');
const { FileAccess } = require('./file-access');
const access = new FileAccess();
// Keep the existing library profile while updating the visible application name.
const existingUserData = app.getPath('userData');
app.setName('SoundPlayer');
app.setPath('userData', existingUserData);
if (process.env.SOUNDPLAYER_TEST_PROFILE) app.setPath('userData', process.env.SOUNDPLAYER_TEST_PROFILE);
const trustedURL = pathToFileURL(path.join(__dirname, 'index.html')).href;

function createWindow() {
    const win = new BrowserWindow({
        show: !process.env.SOUNDPLAYER_TEST_PROFILE,
        width: 1200,
        height: 800,
        webPreferences: {
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.loadFile(path.join(__dirname, 'index.html'));
    let closing = false;
    win.on('close', event => {
        if (closing || win.webContents.isDestroyed()) return;
        event.preventDefault();
        closing = true;
        Promise.race([
            win.webContents.executeJavaScript('window.soundPlayer && !window.soundPlayer.libraryBusy ? window.soundPlayer.saveState() : null').catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 1500))
        ]).finally(() => { if (!win.isDestroyed()) win.close(); });
    });


    // Create menu
    createMenu();
}

function createMenu() {
    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Exit',
                    accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
                    click: () => {
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About SoundPlayer',
                    click: () => {
                        showAboutDialog();
                    }
                }
            ]
        }
    ];

    // macOS specific menu adjustments
    if (process.platform === 'darwin') {
        template.unshift({
            label: app.getName(),
            submenu: [
                {
                    label: 'About SoundPlayer',
                    click: () => {
                        showAboutDialog();
                    }
                },
                { type: 'separator' },
                {
                    label: 'Quit',
                    accelerator: 'Command+Q',
                    click: () => {
                        app.quit();
                    }
                }
            ]
        });

        // Remove About from Help menu on macOS since it's in the app menu
        template[2].submenu = template[2].submenu.filter(item => item.label !== 'About SoundPlayer');
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function showAboutDialog() {
    dialog.showMessageBox({
        type: 'info',
        title: 'About SoundPlayer',
        message: 'SoundPlayer',
        detail: `Version: ${app.getVersion()}\n\nA modern audio player with spectrum visualization and library management.\n\nCreated by @AntDX316\nTwitter/X: https://x.com/AntDX316\n\nBuilt with Electron and Web Technologies\n\n© 2024 SoundPlayer`,
        buttons: ['OK'],
        defaultId: 0
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Restrict privileged calls to this application's top-level renderer.
function trusted(event) {
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== trustedURL) {
        throw new Error('Untrusted IPC sender');
    }
}
ipcMain.handle('show-save-dialog', async event => {
    trusted(event);
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Save Library', defaultPath: 'soundplayer-library.zip',
        filters: [{ name: 'ZIP Libraries', extensions: ['zip'] }]
    });
    return result.canceled ? undefined : access.grant(result.filePath, 'write');
});
ipcMain.handle('show-open-dialog', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Load Library', properties: ['openFile'], filters: [{ name: 'ZIP Libraries', extensions: ['zip'] }]
    });
    return result.canceled ? undefined : access.grant(result.filePaths[0], 'read');
});
ipcMain.handle('save-file', async (event, file, data) => { trusted(event); return access.write(file, data); });
ipcMain.handle('load-file', async (event, file) => { trusted(event); return access.read(file); });
