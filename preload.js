const { contextBridge, ipcRenderer } = require('electron');

// Only expose APIs not handled by Electron's extension support
contextBridge.exposeInMainWorld('chrome', {
    settings: {
        // Add minimal settings API that extension might need
        get: (details, callback) => {
            if (callback) callback({});
        },
        set: (details, callback) => {
            if (callback) callback();
        }
    },
    proxy: {
        settings: {
            set: async (config) => {
                try {
                    // Forward proxy settings to local proxy server
                    await fetch('http://localhost:2080/proxy/configure', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(config.value)
                    });
                    if (config.callback) config.callback();
                } catch (error) {
                    console.error('Failed to configure proxy:', error);
                    throw error;
                }
            },
            get: (details, callback) => {
                fetch('http://localhost:2080/status')
                    .then(res => res.json())
                    .then(status => {
                        callback({
                            value: status.proxyConfig || { mode: 'direct' },
                            levelOfControl: 'controlled_by_this_extension'
                        });
                    })
                    .catch(() => {
                        callback({
                            value: { mode: 'direct' },
                            levelOfControl: 'not_controllable'
                        });
                    });
            },
            clear: (details, callback) => {
                fetch('http://localhost:2080/proxy/configure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'direct' })
                })
                .then(() => callback && callback())
                .catch(error => console.error('Failed to clear proxy:', error));
            },
            onProxyError: {
                addListener: (listener) => {
                    ipcRenderer.on('proxy-error', (_, error) => listener(error));
                }
            }
        }
    },
    privacy: {
        network: {
            webRTCIPHandlingPolicy: {
                set: (details, callback) => {
                    if (callback) callback();
                },
                get: (details, callback) => {
                    callback({
                        value: 'disable_non_proxied_udp',
                        levelOfControl: 'controlled_by_this_extension'
                    });
                }
            }
        }
    },
    action: {
        setBadgeText: (details, callback) => {
            if (callback) callback();
        },
        setBadgeBackgroundColor: (details, callback) => {
            if (callback) callback();
        }
    },
    browserAction: {
        setBadgeText: (details, callback) => {
            if (callback) callback();
        },
        setBadgeBackgroundColor: (details, callback) => {
            if (callback) callback();
        }
    }
});

// Only expose browser if it doesn't already exist
if (!window.browser) {
    contextBridge.exposeInMainWorld('browser', window.chrome);
}