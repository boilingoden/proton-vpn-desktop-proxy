const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const ProxyServer = require('./server');

let mainWindow;
let proxyServer;

async function initProxyServer() {
    proxyServer = new ProxyServer();
    await proxyServer.start(2080); // Local proxy will run on 2080
    console.log('Local proxy server started on port 2080');
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.resolve(__dirname, 'preload.js')
        }
    });

    // Load the extension from the extension directory (contains built files)
    session.defaultSession.loadExtension(
        path.resolve(__dirname, 'extension')
    ).then(({ id }) => {
        console.log('Extension loaded with ID:', id);
        // Load the extension's popup.html directly
        mainWindow.loadFile(path.join(__dirname, 'extension', 'popup.html'));
    }).catch(err => {
        console.error('Failed to load extension:', err);
        mainWindow.loadURL('data:text/html,Failed to load VPN extension');
    });
}

// App lifecycle
app.whenReady().then(async () => {
    await initProxyServer();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (proxyServer) {
            proxyServer.clearProxy();
        }
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
