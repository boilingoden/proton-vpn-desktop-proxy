import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
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
            }
        }
    }
);