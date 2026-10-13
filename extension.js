import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LlamaDbusInterface = `
<node>
  <interface name="com.github.token419.LlamaDbusd">
    <property name="IsOnline" type="b" access="read"/>
    <property name="AvailableModels" type="as" access="read"/>
    <property name="LoadedModels" type="as" access="read"/>
    <signal name="ModelsChanged"/>
    <method name="UnloadModel">
      <arg type="s" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="LoadModel">
      <arg type="s" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
  </interface>
</node>`;

export default class LlamaDbusExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._settings = this.getSettings();
        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);

        const iconFile = this.dir.get_child('icons').get_child('llama-ai-symbolic.svg');
        const gicon = Gio.FileIcon.new(iconFile);

        const icon = new St.Icon({
            gicon,
            fallback_icon_name: 'dialog-information-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);

        this._indicator.menu.box.add_style_class_name('llama-menu-layout');

        this._statusHeaderItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'llama-model-item llama-status-header',
        });

        this._statusIcon = new St.Icon({
            style_class: 'llama-small-icon llama-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._statusHeaderItem.add_child(this._statusIcon);

        this._statusLabel = new St.Label({
            style_class: 'llama-menu-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._statusHeaderItem.add_child(this._statusLabel);

        const cogIcon = new St.Icon({
            icon_name: 'emblem-system-symbolic',
            style_class: 'llama-small-icon',
        });
        const settingsBtn = new St.Button({
            style_class: 'button llama-icon-btn',
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: this.gettext('Preferences'),
        });
        settingsBtn.add_child(cogIcon);
        settingsBtn.connect('clicked', () => {
            this._indicator.menu.close();
            this.openPreferences();
        });
        this._statusHeaderItem.add_child(settingsBtn);

        this._indicator.menu.addMenuItem(this._statusHeaderItem);

        this._loadedSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._loadedSection);

        this._availableSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._availableSection);
        this._availableListSection = null;
        this._availableScrollView = null;

        this._busyModels = new Set();
        this._dbusProxy = null;
        this._nameOwnerId = null;
        this._propertiesChangedId = null;
        this._modelsChangedId = null;
        this._modelsChangedTimeoutId = null;

        this._updateUI(false, false, [], []);
        this._initDbusProxy();

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._modelsChangedTimeoutId) {
            GLib.Source.remove(this._modelsChangedTimeoutId);
            this._modelsChangedTimeoutId = null;
        }

        if (this._dbusProxy) {
            if (this._nameOwnerId) {
                this._dbusProxy.disconnect(this._nameOwnerId);
                this._nameOwnerId = null;
            }
            if (this._propertiesChangedId) {
                this._dbusProxy.disconnect(this._propertiesChangedId);
                this._propertiesChangedId = null;
            }
            if (this._modelsChangedId) {
                this._dbusProxy.disconnectSignal(this._modelsChangedId);
                this._modelsChangedId = null;
            }
            this._dbusProxy = null;
        }

        if (this._availableListSection) {
            this._availableListSection.destroy();
            this._availableListSection = null;
        }

        if (this._availableScrollView) {
            this._availableScrollView.destroy();
            this._availableScrollView = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._statusHeaderItem = null;
        this._statusIcon = null;
        this._statusLabel = null;
        this._loadedSection = null;
        this._availableSection = null;
        this._settings = null;

        if (this._busyModels) {
            this._busyModels.clear();
            this._busyModels = null;
        }
    }

    _initDbusProxy() {
        try {
            const LlamaProxyClass = Gio.DBusProxy.makeProxyWrapper(LlamaDbusInterface);

            this._dbusProxy = new LlamaProxyClass(
                Gio.DBus.session,
                'com.github.token419.LlamaDbusd',
                '/',
                (proxy, error) => {
                    if (this._cancellable?.is_cancelled() || !proxy)
                        return;

                    if (error) {
                        console.error(`[llama-dbusd-manager] D-Bus proxy init failed: ${error.message}`);
                        return;
                    }

                    if (!this._busyModels)
                        return;

                    proxy.set_default_timeout(120000);

                    this._nameOwnerId = proxy.connect(
                        'notify::g-name-owner',
                        () => this._checkLifecycleState()
                    );
                    this._propertiesChangedId = proxy.connect(
                        'g-properties-changed',
                        () => this._checkLifecycleState()
                    );
                    this._modelsChangedId = proxy.connectSignal(
                        'ModelsChanged',
                        () => this._queueStateCheck()
                    );

                    this._checkLifecycleState();
                },
                this._cancellable
            );
        } catch (error) {
            console.error('[llama-dbusd-manager] Failed to initialize D-Bus proxy:', error);
            this._updateUI(false, false, [], []);
        }
    }

    _queueStateCheck() {
        if (this._modelsChangedTimeoutId) {
            GLib.Source.remove(this._modelsChangedTimeoutId);
            this._modelsChangedTimeoutId = null;
        }
        this._modelsChangedTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            100,
            () => {
                this._modelsChangedTimeoutId = null;
                if (this._cancellable?.is_cancelled() || !this._dbusProxy)
                    return GLib.SOURCE_REMOVE;

                this._checkLifecycleState();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _checkLifecycleState() {
        if (this._cancellable?.is_cancelled() || !this._dbusProxy)
            return;

        if (!this._dbusProxy.g_name_owner) {
            this._updateUI(false, false, [], []);
            return;
        }

        try {
            const isLlamaOnline = Boolean(this._dbusProxy.IsOnline);
            const rawAvailable = this._dbusProxy.AvailableModels;
            const rawLoaded = this._dbusProxy.LoadedModels;

            const availableModels = Array.isArray(rawAvailable)
                ? Array.from(rawAvailable).map(String)
                : [];

            const loadedModels = Array.isArray(rawLoaded)
                ? Array.from(rawLoaded).map(String)
                : [];

            this._updateUI(true, isLlamaOnline, availableModels, loadedModels);
        } catch (error) {
            console.error(`[llama-dbusd-manager] Property synchronization exception: ${error}`);
            this._updateUI(true, false, [], []);
        }
    }

    _updateUI(daemonOnline, llamaOnline, availableModels, loadedModels) {
        if (this._cancellable?.is_cancelled() || !this._statusHeaderItem || !this._loadedSection || !this._availableSection)
            return;

        const cleanLoaded = (Array.isArray(loadedModels) ? loadedModels : [])
            .map(item => (typeof item === 'string' ? item.trim() : String(item).trim()))
            .filter(Boolean);

        const cleanAvailable = (Array.isArray(availableModels) ? availableModels : [])
            .map(item => (typeof item === 'string' ? item.trim() : String(item).trim()))
            .filter(Boolean);

        const statusIconName = 'media-record-symbolic';
        let statusText = this.gettext('D-Bus Server Offline');
        let labelStyleClass = 'llama-status-dbus-offline';

        if (daemonOnline) {
            statusText = llamaOnline
                ? this.gettext('Server Status: Online')
                : this.gettext('Server Status: Offline');
            labelStyleClass = llamaOnline ? 'llama-status-online' : 'llama-status-offline';
        }

        this._statusIcon.icon_name = statusIconName;
        this._statusIcon.style_class = `llama-small-icon llama-status-icon ${labelStyleClass}`;
        this._statusLabel.text = statusText;

        if (this._availableListSection) {
            this._availableListSection.destroy();
            this._availableListSection = null;
        }

        if (this._availableScrollView) {
            this._availableScrollView.destroy();
            this._availableScrollView = null;
        }

        this._loadedSection.removeAll();
        this._availableSection.removeAll();

        const loadedSet = new Set(cleanLoaded);

        if (cleanLoaded.length > 0 && daemonOnline) {
            this._loadedSection.box.visible = true;

            const loadedTitleItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            loadedTitleItem.add_child(new St.Label({
                text: this.gettext('LOADED MODELS'),
                style_class: 'llama-section-header',
            }));
            this._loadedSection.addMenuItem(loadedTitleItem);

            cleanLoaded.forEach(m => {
                const isBusy = this._busyModels?.has(m);
                const row = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    can_focus: false,
                    style_class: 'llama-model-item',
                });

                const ejectIcon = new St.Icon({
                    icon_name: isBusy ? 'process-working-symbolic' : 'media-eject-symbolic',
                    style_class: 'llama-small-icon',
                });
                const unloadBtn = new St.Button({
                    style_class: 'button llama-icon-btn',
                    can_focus: !isBusy,
                    reactive: !isBusy,
                    y_align: Clutter.ActorAlign.CENTER,
                    opacity: isBusy ? 128 : 255,
                    accessible_name: `${this.gettext('Unload model')}: ${m}`,
                });
                unloadBtn.add_child(ejectIcon);
                unloadBtn.connect('clicked', () => {
                    this._busyModels?.add(m);
                    unloadBtn.reactive = false;
                    unloadBtn.can_focus = false;
                    unloadBtn.opacity = 128;
                    ejectIcon.icon_name = 'process-working-symbolic';

                    this._dbusProxy?.UnloadModelRemote(m, this._cancellable, (_result, error) => {
                        if (this._cancellable?.is_cancelled() || !this._dbusProxy || !this._busyModels)
                            return;

                        this._busyModels.delete(m);
                        if (error) {
                            console.error(`[llama-dbusd-manager] Failed to unload model ${m}:`, error);
                            Main.notifyError(this.gettext('Failed to unload model'), error.message);
                        }
                        this._checkLifecycleState();
                    });
                });
                row.add_child(unloadBtn);

                const nameLabel = new St.Label({
                    text: m,
                    style_class: 'llama-loaded-model-label',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                row.add_child(nameLabel);

                const chatIcon = new St.Icon({
                    icon_name: 'user-available-symbolic',
                    style_class: 'llama-small-icon',
                });
                const chatBtn = new St.Button({
                    style_class: 'button llama-icon-btn',
                    can_focus: true,
                    reactive: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    accessible_name: `${this.gettext('Open chat in browser')}: ${m}`,
                });
                chatBtn.add_child(chatIcon);
                chatBtn.connect('clicked', () => {
                    this._indicator.menu.close();
                    this._openChatWindow();
                });
                row.add_child(chatBtn);

                this._loadedSection.addMenuItem(row);
            });
        } else {
            this._loadedSection.box.visible = false;
        }

        if (daemonOnline) {
            this._availableSection.box.visible = true;

            const availableTitleItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            availableTitleItem.add_child(new St.Label({
                text: this.gettext('AVAILABLE MODELS'),
                style_class: 'llama-section-header',
            }));
            this._availableSection.addMenuItem(availableTitleItem);

            const filteredAvail = cleanAvailable.filter(x => !loadedSet.has(x));

            if (filteredAvail.length === 0) {
                const emptyItem = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    can_focus: false,
                });
                emptyItem.add_child(new St.Label({
                    text: this.gettext('No Available Models Found\nVerify llama.cpp paths or check download logs.'),
                    style_class: 'llama-empty-message',
                }));
                this._availableSection.addMenuItem(emptyItem);
            } else {
                this._availableListSection = new PopupMenu.PopupMenuSection();
                this._availableScrollView = new St.ScrollView({
                    style_class: 'llama-available-scroll-view',
                    hscrollbar_policy: St.PolicyType.NEVER,
                    vscrollbar_policy: St.PolicyType.AUTOMATIC,
                });
                this._availableScrollView.add_child(this._availableListSection.box);

                filteredAvail.forEach(m => {
                    const isBusy = this._busyModels?.has(m);
                    const row = new PopupMenu.PopupBaseMenuItem({
                        reactive: false,
                        can_focus: false,
                        style_class: 'llama-model-item',
                    });

                    const playIcon = new St.Icon({
                        icon_name: isBusy ? 'process-working-symbolic' : 'media-playback-start-symbolic',
                        style_class: 'llama-small-icon',
                    });
                    const loadBtn = new St.Button({
                        style_class: 'button llama-icon-btn',
                        can_focus: !isBusy,
                        reactive: !isBusy,
                        y_align: Clutter.ActorAlign.CENTER,
                        opacity: isBusy ? 128 : 255,
                        accessible_name: `${this.gettext('Load model')}: ${m}`,
                    });
                    loadBtn.add_child(playIcon);

                    loadBtn.connect('clicked', () => {
                        this._busyModels?.add(m);
                        loadBtn.reactive = false;
                        loadBtn.can_focus = false;
                        loadBtn.opacity = 128;
                        playIcon.icon_name = 'process-working-symbolic';

                        this._dbusProxy?.LoadModelRemote(m, this._cancellable, (_result, error) => {
                            if (this._cancellable?.is_cancelled() || !this._dbusProxy || !this._busyModels)
                                return;

                            this._busyModels.delete(m);
                            if (error) {
                                console.error(`[llama-dbusd-manager] Failed to load model ${m}:`, error);
                                Main.notifyError(this.gettext('Failed to load model'), error.message);
                            }
                            this._checkLifecycleState();
                        });
                    });

                    const nameLabel = new St.Label({
                        text: m,
                        style_class: 'llama-available-model-label',
                        x_expand: true,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

                    row.add_child(loadBtn);
                    row.add_child(nameLabel);
                    this._availableListSection.addMenuItem(row);
                });

                this._availableSection.box.add_child(this._availableScrollView);
            }
        } else {
            this._availableSection.box.visible = false;
        }
    }

    _openChatWindow() {
        if (!this._settings)
            return;

        const rawUrl = this._settings.get_string('server-url');
        if (!rawUrl)
            return;

        let targetUrl = rawUrl.trim();
        if (!targetUrl)
            return;

        const lowerUrl = targetUrl.toLowerCase();
        if (!lowerUrl.startsWith('http://') && !lowerUrl.startsWith('https://'))
            targetUrl = `http://${targetUrl}`;

        try {
            const context = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri_async(targetUrl, context, this._cancellable, (o, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                } catch (err) {
                    console.error('[llama-dbusd-manager] Failed to launch chat URL:', err);
                }
            });
        } catch (err) {
            console.error('[llama-dbusd-manager] Failed to initiate chat URL launch:', err);
        }
    }
}
