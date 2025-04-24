import { Settings, DEFAULT_SETTINGS } from '../common/types';
import Store from 'electron-store';

export class SettingsManager {
    private store: Store;

    constructor() {
        this.store = new Store();
        // Initialize settings if they don't exist
        if (!this.store.has('settings')) {
            this.store.set('settings', DEFAULT_SETTINGS);
        }
    }

    public getSettings(): Settings {
        return this.store.get('settings') as Settings;
    }

    public saveSettings(settings: Settings): void {
        this.store.set('settings', settings);
    }
}