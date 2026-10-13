import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LlamaDbusPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Create a standard settings page cleanly without importing extension.js hooks
        const page = new Adw.PreferencesPage({
            title: this.gettext('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: this.gettext('Connection Configuration'),
            description: this.gettext('Configure how the desktop extension communicates with your local environment.'),
        });
        page.add(group);

        const urlRow = new Adw.EntryRow({
            title: this.gettext('Llama Server URL'),
            show_apply_button: false,
        });
        group.add(urlRow);

        const settings = this.getSettings();
        let savedUrl = settings.get_string('server-url');
        urlRow.text = savedUrl;

        const updateApplyButton = () => {
            const current = urlRow.text.trim();
            urlRow.show_apply_button = Boolean(current && current !== savedUrl);
        };

        urlRow.connect('notify::text', () => {
            updateApplyButton();
        });

        urlRow.connect('apply', () => {
            let url = urlRow.text.trim();
            if (url) {
                const lower = url.toLowerCase();
                if (!lower.startsWith('http://') && !lower.startsWith('https://'))
                    url = `http://${url}`;
                savedUrl = url;
                urlRow.text = url;
                settings.set_string('server-url', url);
                updateApplyButton();
            }
        });

        const settingsId = settings.connect('changed::server-url', () => {
            savedUrl = settings.get_string('server-url');
            if (urlRow.text !== savedUrl) {
                urlRow.text = savedUrl;
                updateApplyButton();
            }
        });

        window.connect('close-request', () => {
            settings.disconnect(settingsId);
            return false;
        });
    }
}
