# llama-dbusd Manager (GNOME Shell Extension)

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-45%20through%2051-blue.svg)](https://extensions.gnome.org/)
[![GJS](https://img.shields.io/badge/GJS-ESM-yellow.svg)](https://gjs.guide/)
[![D-Bus Interface](https://img.shields.io/badge/D--Bus-com.github.token419.LlamaDbusd-blue.svg)](https://www.freedesktop.org/wiki/Software/dbus/)
[![Companion Daemon](https://img.shields.io/badge/companion-llama--dbusd-orange.svg)](https://github.com/token419/llama-dbusd)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A GNOME Shell extension providing a top bar system indicator to monitor, load, and unload `llama.cpp` / `llama-server` models using [`llama-dbusd`](https://github.com/token419/llama-dbusd).

---

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Installation](#installation)
  - [From Source / Git](#from-source--git)
- [Configuration](#configuration)
- [Packaging](#packaging)
- [AI Assistance Attestation](#ai-assistance-attestation)
- [License](#license)

---

## Overview

`llama-dbusd-manager` pairs with the companion Rust service [`llama-dbusd`](https://github.com/token419/llama-dbusd) over the Session D-Bus bus. It allows you to:
- Monitor status of the local `llama.cpp` HTTP server (Online / Offline / D-Bus disconnected).
- View currently loaded models and unload them with a single click.
- Browse available models and load them into memory/GPU on demand.
- Open the active web chat interface directly in your default browser.
- Configure custom llama server URLs via the GNOME extension preferences window.

---

## Requirements

- **GNOME Shell:** 45 through 51 (ESM)
- **Companion Daemon:** `llama-dbusd` running on your user session bus (`com.github.token419.LlamaDbusd`)
- **Backend:** `llama-server` (from `llama.cpp`) running locally or on a reachable network host

---

## Installation

### From Source / Git

Clone or symlink this directory into your GNOME extensions user folder:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
git clone https://github.com/token419/llama-dbusd-manager.git ~/.local/share/gnome-shell/extensions/llama-dbusd-manager@token419.github.com
```

Compile the GSettings schema:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/llama-dbusd-manager@token419.github.com/schemas/
```

Enable the extension:

```bash
gnome-extensions enable llama-dbusd-manager@token419.github.com
```

*(Note: On X11, you can restart GNOME Shell with `Alt+F2`, then `r`. On Wayland, log out and log back in or use nested session).*

---

## Configuration

Open Preferences from the extension menu or run:

```bash
gnome-extensions prefs llama-dbusd-manager@token419.github.com
```

- **Llama Server URL**: The endpoint for your `llama-server` instance (default: `http://127.0.0.1:8080`).

---

## Packaging

To package the extension into an installable zip bundle:

```bash
gnome-extensions pack --extra-source=icons --force
```

---

## AI Assistance Attestation

```
Built in collaboration with Google Gemini.
```

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
