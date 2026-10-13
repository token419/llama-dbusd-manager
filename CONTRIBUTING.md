# Contributing to llama-dbusd Manager

Thank you for your interest in contributing to `llama-dbusd-manager`. This document outlines the technical standards, architectural patterns, local development environment, and submission workflow required for all contributions.

---

## 1. Welcome & Repo Philosophy

`llama-dbusd-manager` is a lean, Free and Open Source (FOSS) GNOME Shell top bar extension engineered to provide seamless desktop monitoring and runtime control over local `llama.cpp` inference instances via the companion `llama-dbusd` D-Bus daemon.

Our contribution philosophy adheres to the following engineering principles:

* **Explicit Problem Solving**: We prioritize verifiable engineering solutions over speculative abstractions. Every change should solve a defined problem, improve desktop responsiveness, or fix a reproducible bug.
* **Structural Clarity & Minimalism**: Keep the codebase compact, legible, and maintainable. Avoid unnecessary dependencies, complex wrappers, or heavy abstractions around native GNOME Shell APIs.
* **Minimal Conversational Fluff**: PRs and issue tickets should be direct and technical. Provide concrete reproductions, shell logs (`journalctl`), steps to reproduce, and architectural rationale rather than conversational pleasantries.
* **Deterministic Shell Safety**: As code executing directly within the compositor process (`gnome-shell`), this extension must never freeze UI rendering, leak GObjects or signal handlers, or crash the user's desktop session.

---

## 2. Development Environment Workflow

Our baseline development environment is **Arch Linux** with modern GNOME Shell. Contributors running Arch or Arch-based distributions should use native system tooling and standard GNOME development packages.

### 2.1 System Dependencies

Install the required GNOME Shell development tools, GJS runtime, and gettext translation utilities using `pacman` or your preferred AUR helper (`paru` / `parman`):

```bash
# Using standard pacman
sudo pacman -S --needed gnome-shell gjs glib2 gettext git

# Or using paru
paru -S --needed gnome-shell gjs glib2 gettext git

# Or using parman
parman install gnome-shell gjs glib2 gettext git
```

The extension runtime requires GNOME Shell 45+ with ESM module support and the user session D-Bus daemon.

### 2.2 Local Repository Setup & Symlinking

Clone the repository and symlink it into your user GNOME Shell extensions folder:

```bash
git clone https://github.com/token419/llama-dbusd-manager.git
cd llama-dbusd-manager

# Create extensions directory if needed
mkdir -p ~/.local/share/gnome-shell/extensions

# Symlink development folder directly into GNOME Shell extensions
ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/llama-dbusd-manager@token419.github.com
```

### 2.3 Compiling Schema & Enabling Extension

Compile the GSettings XML schema into the local directory and enable the extension:

```bash
# Compile local GSettings schema
glib-compile-schemas schemas/

# Enable extension
gnome-extensions enable llama-dbusd-manager@token419.github.com
```

*(Note: On X11 sessions, you can restart GNOME Shell with `Alt+F2`, then typing `r` and pressing Enter. On Wayland sessions, test inside a nested session or log out and log back in).*

### 2.4 Testing in a Nested GNOME Shell (Wayland)

For safe testing without disrupting your primary desktop session, launch a nested GNOME Shell window:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

### 2.5 Monitoring Logs & Debugging

Filter shell journal messages in real-time to monitor extension logs and errors:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell | grep --line-buffered "llama-dbusd-manager"
```

To test the companion D-Bus daemon operations independently, use `busctl`:

```bash
# Introspect the daemon interface
busctl --user introspect com.github.token419.LlamaDbusd /

# Inspect properties
busctl --user get-property com.github.token419.LlamaDbusd / com.github.token419.LlamaDbusd IsOnline
busctl --user get-property com.github.token419.LlamaDbusd / com.github.token419.LlamaDbusd AvailableModels
busctl --user get-property com.github.token419.LlamaDbusd / com.github.token419.LlamaDbusd LoadedModels

# Monitor live D-Bus signal emissions
busctl --user monitor com.github.token419.LlamaDbusd
```

---

## 3. Code & Style Constraints

All contributions are subject to rigorous review against GNOME Shell Extension standards and EGO guidelines.

### 3.1 GJS ESM Imports & Modern Architecture

GNOME Shell 45+ uses native ECMAScript Modules (ESM). Do not use legacy `imports.*` syntax:

```javascript
// CORRECT: Modern ESM imports
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
```

In `prefs.js`, import Libadwaita and `ExtensionPreferences`:

```javascript
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
```

### 3.2 Strict Lifecycle Management (`enable()` and `disable()`)

Everything allocated, connected, or registered during `enable()` **must** be cleanly destroyed, removed, or nullified in `disable()`:

1. **Main Loop Sources**: Always remove active timeouts or intervals (`GLib.Source.remove(this._sourceId)`) on disable or before scheduling a new source.
2. **Signal Connections**: Disconnect all D-Bus proxy signal listeners (`disconnect()`, `disconnectSignal()`) and GSettings listeners.
3. **Actor Destruction**: Call `.destroy()` on the panel indicator (`this._indicator.destroy()`), scroll containers, and any actors dynamically attached outside the default menu hierarchy.
4. **Cancellables**: Cancel in-flight asynchronous operations via `this._cancellable.cancel()`.
5. **No Lingering State**: Reset all instance references to `null` to ensure garbage collection.

### 3.3 Asynchronous Safety & D-Bus IPC

* Pass `this._cancellable` to remote D-Bus calls (`LoadModelRemote`, `UnloadModelRemote`) and async operations to ensure operations abort cleanly when the extension is disabled.
* Guard async callbacks against execution after disable:
  ```javascript
  if (this._cancellable?.is_cancelled() || !this._dbusProxy)
      return;
  ```
* Handle async completion errors explicitly (e.g., via `Gio.AppInfo.launch_default_for_uri_finish`) rather than ignoring callbacks.
* Provide user feedback on failure using `Main.notifyError(this.gettext('...'), error.message)`.

### 3.4 Logging Standards

* **No Debug Spam**: Never commit `console.log()` statements.
* **Standardized Prefixes**: Use `console.error` with the `[llama-dbusd-manager]` prefix exclusively for actionable system or network failures:
  ```javascript
  console.error('[llama-dbusd-manager] Failed to load model:', error);
  ```

### 3.5 CSS & Scoped Styling

GNOME Shell injects extension stylesheets into the global compositor theme. All CSS rules in `stylesheet.css` **must** be strictly scoped:

* Use the `.llama-*` class prefix (e.g., `.llama-menu-layout`, `.llama-model-item`, `.llama-icon-btn`).
* Never define unscoped generic selectors like `button { ... }`, `.popup-menu { ... }`, or raw actor tags.
* Use native St/Clutter properties (`spacing`, `icon-size`) rather than browser-specific flexbox properties.

### 3.6 Internationalization (i18n)

* Wrap all user-facing strings using `this.gettext('...')`.
* When adding or modifying strings, regenerate the translation template:
  ```bash
  xgettext --from-code=UTF-8 --language=JavaScript --keyword=gettext --output=po/llama-dbusd-manager.pot extension.js prefs.js
  ```

---

## 4. Packaging & Verification

Before submitting changes, perform complete local verification:

### 4.1 Syntax & Schema Validation

Verify JavaScript syntax and ensure the GSettings schema complies with strict GLib validation:

```bash
# Check JavaScript syntax
node --check extension.js
node --check prefs.js

# Validate GSettings schema strictly
glib-compile-schemas --strict --dry-run schemas/

# Validate translation template
msgfmt -c --check-header -o /dev/null po/llama-dbusd-manager.pot
```

### 4.2 Bundle Packaging

Package the extension using the official GNOME tooling:

```bash
gnome-extensions pack --extra-source=icons --force
```

Inspect the generated zip archive to confirm it contains only runtime files:

```bash
unzip -l llama-dbusd-manager@token419.github.com.shell-extension.zip
```

Verify that development files (`.git`, `README.md`, `LICENSE`, `CONTRIBUTING.md`, `schemas/gschemas.compiled`) are excluded from the zip bundle.

---

## 5. Pull Requests & Releases

### 5.1 Branching & Commit Guidelines

* Base your branch on the latest `master` (or `main`) branch.
* Use clear, imperative commit messages adhering to standard conventional commit prefixes:
  * `feat: add model memory footprint indicator`
  * `fix: prevent menu closure during asynchronous load`
  * `style: tighten item padding in compact mode`
  * `i18n: add German translation catalog`
  * `chore: update target shell versions for GNOME 52`

### 5.2 Pull Request Checklist

Before submitting a pull request, ensure:
1. [ ] JavaScript passes `node --check` without syntax errors.
2. [ ] Extension enables and disables cleanly multiple times without journal errors.
3. [ ] Memory leak checks pass (all timers and listeners destroyed in `disable()`).
4. [ ] All custom styles in `stylesheet.css` are scoped under `.llama-*`.
5. [ ] Any new translatable strings are wrapped with `this.gettext()` and updated in `po/llama-dbusd-manager.pot`.
6. [ ] Bundle packages cleanly with `gnome-extensions pack --extra-source=icons --force`.
