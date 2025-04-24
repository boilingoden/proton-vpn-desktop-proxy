import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld(
    'electron',
    {
        ipcRenderer: {
            invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
            on: (channel: string, func: (...args: any[]) => void) => {
                ipcRenderer.on(channel, (event, ...args) => func(...args));
            },
            once: (channel: string, func: (...args: any[]) => void) => {
                ipcRenderer.once(channel, (event, ...args) => func(...args));
            },
            removeAllListeners: (channel: string) => {
                ipcRenderer.removeAllListeners(channel);
            },
            // Add auth callback listener
            handleAuthCallback: (callback: (url: string) => void) => {
                ipcRenderer.on('auth:callback', (_event, url) => callback(url));
            }
        }
    }
);