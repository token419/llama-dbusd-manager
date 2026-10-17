import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

const LlamaDbusInterface = `
<node>
  <interface name="com.github.token419.LlamaDbusd">
    <property name="ServerUrl" type="s" access="read"/>
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

function _logError(msg, err = null) {
    if (err)
        console.error(`[llama-dbusd-manager] ${msg}:`, err);
    else
        console.error(`[llama-dbusd-manager] ${msg}`);
}

export default class LlamaDbusExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
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

        const statusHeaderItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'llama-model-item llama-status-header',
        });

        this._statusIcon = new St.Icon({
            style_class: 'llama-small-icon llama-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusHeaderItem.add_child(this._statusIcon);

        this._statusLabel = new St.Label({
            style_class: 'llama-menu-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusHeaderItem.add_child(this._statusLabel);

        this._indicator.menu.addMenuItem(statusHeaderItem);

        this._loadedSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._loadedSection);

        const loadedTitleItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        loadedTitleItem.add_child(new St.Label({
            text: this.gettext('LOADED MODELS'),
            style_class: 'llama-section-header',
        }));
        this._loadedSection.addMenuItem(loadedTitleItem);

        this._availableSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._availableSection);

        const availableTitleItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        availableTitleItem.add_child(new St.Label({
            text: this.gettext('AVAILABLE MODELS'),
            style_class: 'llama-section-header',
        }));
        this._availableSection.addMenuItem(availableTitleItem);

        this._availableEmptyItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._availableEmptyItem.add_child(new St.Label({
            text: this.gettext('No Available Models Found\nVerify llama.cpp paths or check download logs.'),
            style_class: 'llama-empty-message',
        }));
        this._availableSection.addMenuItem(this._availableEmptyItem);

        const boxProps = { x_expand: true };
        if (St.BoxLayout.find_property('orientation'))
            boxProps.orientation = Clutter.Orientation.VERTICAL;
        else
            boxProps.vertical = true;

        this._availableBox = new St.BoxLayout(boxProps);

        const availableScrollView = new St.ScrollView({
            style_class: 'llama-available-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });

        if (typeof availableScrollView.add_actor === 'function')
            availableScrollView.add_actor(this._availableBox);
        else if (typeof availableScrollView.set_child === 'function')
            availableScrollView.set_child(this._availableBox);
        else
            availableScrollView.add_child(this._availableBox);

        this._availableScrollItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'llama-scroll-menu-item',
        });
        this._availableScrollItem.visible = false;
        this._availableScrollItem.add_child(availableScrollView);
        this._availableSection.addMenuItem(this._availableScrollItem);

        this._loadedRows = new Map();
        this._availableRows = new Map();
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

        if (this._availableRows) {
            for (const item of this._availableRows.values())
                this._destroyRowItem(item);
            this._availableRows.clear();
            this._availableRows = null;
        }

        if (this._loadedRows) {
            for (const item of this._loadedRows.values())
                this._destroyRowItem(item);
            this._loadedRows.clear();
            this._loadedRows = null;
        }

        if (this._availableBox) {
            this._safeDestroyActor(this._availableBox);
            this._availableBox = null;
        }

        if (this._availableScrollItem) {
            this._safeDestroyActor(this._availableScrollItem);
            this._availableScrollItem = null;
        }

        if (this._availableEmptyItem) {
            this._safeDestroyActor(this._availableEmptyItem);
            this._availableEmptyItem = null;
        }

        if (this._availableSection) {
            this._safeDestroyActor(this._availableSection);
            this._availableSection = null;
        }

        if (this._loadedSection) {
            this._safeDestroyActor(this._loadedSection);
            this._loadedSection = null;
        }

        if (this._statusIcon) {
            this._safeDestroyActor(this._statusIcon);
            this._statusIcon = null;
        }

        if (this._statusLabel) {
            this._safeDestroyActor(this._statusLabel);
            this._statusLabel = null;
        }

        if (this._indicator) {
            this._safeDestroyActor(this._indicator);
            this._indicator = null;
        }

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
                    if (!this._cancellable || this._cancellable.is_cancelled() || !proxy)
                        return;

                    if (error) {
                        _logError(`D-Bus proxy init failed: ${error.message}`);
                        return;
                    }

                    if (!this._busyModels)
                        return;

                    // makeProxyWrapper hardcodes -1 (default timeout) for all wrapper methods.
                    // Because LoadModel can take >60s for large LLM weights, proxy default is extended.
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
            _logError('Failed to initialize D-Bus proxy', error);
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
                if (!this._cancellable || this._cancellable.is_cancelled() || !this._dbusProxy)
                    return GLib.SOURCE_REMOVE;

                this._checkLifecycleState();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _checkLifecycleState() {
        if (!this._cancellable || this._cancellable.is_cancelled() || !this._dbusProxy)
            return;

        if (!this._dbusProxy.g_name_owner) {
            this._updateUI(false, false, [], []);
            return;
        }

        try {
            const isLlamaOnline = Boolean(this._dbusProxy?.IsOnline);
            const rawAvailable = this._dbusProxy?.AvailableModels ?? [];
            const rawLoaded = this._dbusProxy?.LoadedModels ?? [];

            const availableModels = Array.isArray(rawAvailable)
                ? Array.from(rawAvailable).map(String)
                : [];

            const loadedModels = Array.isArray(rawLoaded)
                ? Array.from(rawLoaded).map(String)
                : [];

            this._updateUI(true, isLlamaOnline, availableModels, loadedModels);
        } catch (error) {
            _logError(`Property synchronization exception: ${error}`);
            this._updateUI(true, false, [], []);
        }
    }

    _handleFocusTransfer(removedItem, currentMap, fallbackActor) {
        const hadFocus = Boolean(
            removedItem.loadBtn?.has_key_focus() ||
            removedItem.unloadBtn?.has_key_focus() ||
            removedItem.chatBtn?.has_key_focus() ||
            removedItem.row?.has_key_focus()
        );
        if (!hadFocus)
            return;

        const keys = Array.from(currentMap.keys());
        const removedIndex = keys.indexOf(removedItem.name);
        const remainingKeys = keys.filter(k => k !== removedItem.name);

        if (remainingKeys.length > 0) {
            const nextKey = remainingKeys[removedIndex] || remainingKeys[remainingKeys.length - 1];
            const nextItem = currentMap.get(nextKey);
            const focusTarget = nextItem?.loadBtn || nextItem?.unloadBtn;
            if (focusTarget && focusTarget.can_focus) {
                focusTarget.grab_key_focus();
                return;
            }
        }

        if (fallbackActor && fallbackActor.can_focus)
            fallbackActor.grab_key_focus();
    }

    _safeDestroyActor(actor) {
        if (!actor)
            return;

        try {
            if (typeof actor.get_children === 'function') {
                const children = actor.get_children();
                for (const child of children) {
                    this._safeDestroyActor(child);
                }
            }
        } catch {
            // Child detachment fallback
        }

        try {
            const parent = typeof actor.get_parent === 'function' ? actor.get_parent() : null;
            if (parent) {
                if (typeof parent.set_child === 'function' && parent.get_child?.() === actor)
                    parent.set_child(null);
                else if (typeof parent.remove_child === 'function')
                    parent.remove_child(actor);
                else if (typeof parent.remove_actor === 'function')
                    parent.remove_actor(actor);
            }
        } catch {
            // Parent removal fallback
        }

        try {
            if (typeof actor.destroy === 'function')
                actor.destroy();
        } catch {
            // Destruction fallback
        }
    }

    _destroyRowItem(item) {
        if (!item)
            return;

        if (item.playIcon) {
            this._safeDestroyActor(item.playIcon);
            item.playIcon = null;
        }
        if (item.ejectIcon) {
            this._safeDestroyActor(item.ejectIcon);
            item.ejectIcon = null;
        }
        if (item.chatBtn) {
            this._safeDestroyActor(item.chatBtn);
            item.chatBtn = null;
        }
        if (item.loadBtn) {
            this._safeDestroyActor(item.loadBtn);
            item.loadBtn = null;
        }
        if (item.unloadBtn) {
            this._safeDestroyActor(item.unloadBtn);
            item.unloadBtn = null;
        }
        if (item.row) {
            this._safeDestroyActor(item.row);
            item.row = null;
        } else if (typeof item.destroy === 'function') {
            this._safeDestroyActor(item);
        }
    }

    _createLoadedRow(m) {
        const row = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'llama-model-item',
        });

        const ejectIcon = new St.Icon({
            icon_name: 'media-eject-symbolic',
            fallback_icon_name: 'media-playback-stop-symbolic',
            style_class: 'llama-small-icon',
            icon_size: 16,
        });
        const unloadBtn = new St.Button({
            style_class: 'button llama-icon-btn',
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: `${this.gettext('Unload model')}: ${m}`,
            child: ejectIcon,
        });
        if (typeof unloadBtn.set_child === 'function')
            unloadBtn.set_child(ejectIcon);
        unloadBtn.connect('clicked', () => {
            this._busyModels?.add(m);
            unloadBtn.reactive = false;
            unloadBtn.can_focus = false;
            unloadBtn.opacity = 128;
            ejectIcon.icon_name = 'process-working-symbolic';

            this._dbusProxy?.UnloadModelRemote(m, this._cancellable, (_result, error) => {
                if (!this._cancellable || this._cancellable.is_cancelled() || !this._dbusProxy || !this._busyModels)
                    return;

                this._busyModels.delete(m);
                if (error && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    _logError(`Failed to unload model ${m}`, error);
                    Main.notifyError(this.gettext('Failed to unload model'), error.message);
                }
                this._checkLifecycleState();
            });
        });
        unloadBtn.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            const state = event.get_state();
            const isShift = Boolean(state & Clutter.ModifierType.SHIFT_MASK);

            const isFirst = this._loadedRows?.values().next().value?.name === m;
            if (isFirst && (symbol === Clutter.KEY_Up || symbol === Clutter.KEY_ISO_Left_Tab || (symbol === Clutter.KEY_Tab && isShift))) {
                if (this._availableRows?.size > 0) {
                    const rows = Array.from(this._availableRows.values());
                    const lastRow = rows[rows.length - 1];
                    if (lastRow?.loadBtn && lastRow.loadBtn.can_focus) {
                        lastRow.loadBtn.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
                }
            }
            return Clutter.EVENT_PROPAGATE;
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
            icon_size: 16,
        });
        const chatBtn = new St.Button({
            style_class: 'button llama-icon-btn',
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: `${this.gettext('Open chat in browser')}: ${m}`,
            child: chatIcon,
        });
        if (typeof chatBtn.set_child === 'function')
            chatBtn.set_child(chatIcon);
        chatBtn.connect('clicked', () => {
            this._indicator.menu.close();
            this._openChatWindow();
        });
        chatBtn.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            const state = event.get_state();
            const isShift = Boolean(state & Clutter.ModifierType.SHIFT_MASK);

            let isLast = false;
            if (this._loadedRows?.size > 0) {
                const rows = Array.from(this._loadedRows.values());
                isLast = rows[rows.length - 1]?.name === m;
            }

            if (isLast && ((symbol === Clutter.KEY_Tab && !isShift) || symbol === Clutter.KEY_Down)) {
                if (this._availableRows?.size > 0) {
                    const firstAvail = this._availableRows.values().next().value;
                    if (firstAvail?.loadBtn && firstAvail.loadBtn.can_focus) {
                        firstAvail.loadBtn.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        row.add_child(chatBtn);

        return { name: m, row, unloadBtn, ejectIcon, chatBtn };
    }

    _ensureRowVisible(row) {
        try {
            const scrollView = this._availableBox?.get_parent();
            if (scrollView && row && row.get_parent())
                ensureActorVisibleInScrollView(scrollView, row);
        } catch {
            // Non-critical if layout pass has not completed yet
        }
    }

    _createAvailableRow(m) {
        const row = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'llama-model-item',
        });

        const playIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            style_class: 'llama-small-icon',
            icon_size: 16,
        });
        const loadBtn = new St.Button({
            style_class: 'button llama-icon-btn',
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: `${this.gettext('Load model')}: ${m}`,
            child: playIcon,
        });
        if (typeof loadBtn.set_child === 'function')
            loadBtn.set_child(playIcon);

        loadBtn.connect('key-focus-in', () => {
            this._ensureRowVisible(row);
        });

        loadBtn.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            const state = event.get_state();
            const isShift = Boolean(state & Clutter.ModifierType.SHIFT_MASK);

            const isFirst = this._availableRows?.values().next().value?.name === m;
            let isLast = false;
            if (this._availableRows?.size > 0) {
                const rows = Array.from(this._availableRows.values());
                isLast = rows[rows.length - 1]?.name === m;
            }

            if (isLast && ((symbol === Clutter.KEY_Tab && !isShift) || symbol === Clutter.KEY_Down)) {
                if (this._loadedRows?.size > 0) {
                    const firstLoaded = this._loadedRows.values().next().value;
                    const target = firstLoaded?.unloadBtn || firstLoaded?.chatBtn;
                    if (target && target.can_focus) {
                        target.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
                } else if (this._availableRows?.size > 0) {
                    const firstAvail = this._availableRows.values().next().value;
                    if (firstAvail?.loadBtn && firstAvail.loadBtn.can_focus) {
                        firstAvail.loadBtn.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
                }
            }

            if (isFirst && (symbol === Clutter.KEY_Up || symbol === Clutter.KEY_ISO_Left_Tab || (symbol === Clutter.KEY_Tab && isShift))) {
                if (this._loadedRows?.size > 0) {
                    const rows = Array.from(this._loadedRows.values());
                    const lastLoaded = rows[rows.length - 1];
                    const target = lastLoaded?.chatBtn || lastLoaded?.unloadBtn;
                    if (target && target.can_focus) {
                        target.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
                } else if (this._availableRows?.size > 0) {
                    const rows = Array.from(this._availableRows.values());
                    const lastAvail = rows[rows.length - 1];
                    if (lastAvail?.loadBtn && lastAvail.loadBtn.can_focus) {
                        lastAvail.loadBtn.grab_key_focus();
                        return Clutter.EVENT_STOP;
                    }
                }
            }

            return Clutter.EVENT_PROPAGATE;
        });

        loadBtn.connect('clicked', () => {
            this._busyModels?.add(m);
            loadBtn.reactive = false;
            loadBtn.can_focus = false;
            loadBtn.opacity = 128;
            playIcon.icon_name = 'process-working-symbolic';

            this._dbusProxy?.LoadModelRemote(m, this._cancellable, (_result, error) => {
                if (!this._cancellable || this._cancellable.is_cancelled() || !this._dbusProxy || !this._busyModels)
                    return;

                this._busyModels.delete(m);
                if (error && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    _logError(`Failed to load model ${m}`, error);
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

        return { name: m, row, loadBtn, playIcon };
    }

    _updateUI(daemonOnline, llamaOnline, availableModels, loadedModels) {
        if (!this._cancellable || this._cancellable.is_cancelled() || !this._indicator || !this._loadedSection || !this._availableSection)
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

        const loadedSet = new Set(cleanLoaded);

        if (cleanLoaded.length > 0 && daemonOnline) {
            this._loadedSection.box.visible = true;

            for (const [m, item] of this._loadedRows) {
                if (!loadedSet.has(m)) {
                    const fallback = this._availableRows.get(m)?.loadBtn || this._indicator;
                    this._handleFocusTransfer(item, this._loadedRows, fallback);
                    this._destroyRowItem(item);
                    this._loadedRows.delete(m);
                }
            }

            cleanLoaded.forEach((m, idx) => {
                const isBusy = this._busyModels?.has(m);
                if (this._loadedRows.has(m)) {
                    const item = this._loadedRows.get(m);
                    item.unloadBtn.reactive = !isBusy;
                    item.unloadBtn.can_focus = !isBusy;
                    item.unloadBtn.opacity = isBusy ? 128 : 255;
                    item.ejectIcon.icon_name = isBusy ? 'process-working-symbolic' : 'media-eject-symbolic';
                    this._loadedSection.moveMenuItem(item.row, idx + 1);
                } else {
                    const item = this._createLoadedRow(m);
                    item.unloadBtn.reactive = !isBusy;
                    item.unloadBtn.can_focus = !isBusy;
                    item.unloadBtn.opacity = isBusy ? 128 : 255;
                    item.ejectIcon.icon_name = isBusy ? 'process-working-symbolic' : 'media-eject-symbolic';
                    this._loadedSection.addMenuItem(item.row, idx + 1);
                    this._loadedRows.set(m, item);
                }
            });
        } else {
            this._loadedSection.box.visible = false;
            for (const item of this._loadedRows.values())
                this._destroyRowItem(item);
            this._loadedRows.clear();
        }

        if (daemonOnline) {
            this._availableSection.box.visible = true;

            const filteredAvail = cleanAvailable.filter(x => !loadedSet.has(x));

            if (filteredAvail.length === 0) {
                this._availableEmptyItem.visible = true;
                this._availableScrollItem.visible = false;

                for (const item of this._availableRows.values())
                    this._destroyRowItem(item);
                this._availableRows.clear();
            } else {
                this._availableEmptyItem.visible = false;
                this._availableScrollItem.visible = true;

                const availSet = new Set(filteredAvail);

                for (const [m, item] of this._availableRows) {
                    if (!availSet.has(m)) {
                        const fallback = this._loadedRows.get(m)?.unloadBtn || this._indicator;
                        this._handleFocusTransfer(item, this._availableRows, fallback);
                        this._destroyRowItem(item);
                        this._availableRows.delete(m);
                    }
                }

                filteredAvail.forEach((m, idx) => {
                    const isBusy = this._busyModels?.has(m);
                    if (this._availableRows.has(m)) {
                        const item = this._availableRows.get(m);
                        item.loadBtn.reactive = !isBusy;
                        item.loadBtn.can_focus = !isBusy;
                        item.loadBtn.opacity = isBusy ? 128 : 255;
                        item.playIcon.icon_name = isBusy ? 'process-working-symbolic' : 'media-playback-start-symbolic';
                        this._availableBox.set_child_at_index(item.row, idx);
                    } else {
                        const item = this._createAvailableRow(m);
                        item.loadBtn.reactive = !isBusy;
                        item.loadBtn.can_focus = !isBusy;
                        item.loadBtn.opacity = isBusy ? 128 : 255;
                        item.playIcon.icon_name = isBusy ? 'process-working-symbolic' : 'media-playback-start-symbolic';
                        this._availableBox.insert_child_at_index(item.row, idx);
                        this._availableRows.set(m, item);
                    }
                });
            }
        } else {
            this._availableSection.box.visible = false;
            for (const item of this._availableRows.values())
                this._destroyRowItem(item);
            this._availableRows.clear();
        }
    }

    _openChatWindow() {
        const rawUrl = this._dbusProxy?.ServerUrl;
        let targetUrl = (typeof rawUrl === 'string' && rawUrl.trim()) ? rawUrl.trim() : 'http://127.0.0.1:8080';

        const lowerUrl = targetUrl.toLowerCase();
        if (!lowerUrl.startsWith('http://') && !lowerUrl.startsWith('https://'))
            targetUrl = `http://${targetUrl}`;

        try {
            const context = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri_async(targetUrl, context, this._cancellable, (o, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                } catch (err) {
                    _logError('Failed to launch chat URL', err);
                }
            });
        } catch (err) {
            _logError('Failed to initiate chat URL launch', err);
        }
    }
}
