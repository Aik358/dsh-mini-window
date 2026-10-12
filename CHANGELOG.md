# Changelog

All notable changes to `@a9i5k4/dsh-mini-window` are documented here.

---

## 0.2.0 — 2026-10-12

**The mini window is now a real, always-on-top browser window — with zero extra download.**

### Added

- **Floating ball → real standalone mini window.** Clicking the ball opens DSH in a separate
  **520×720 always-on-top browser window**. It is driven through
  `chrome --app=<url>` (Chrome preferred, Edge as fallback), so **nothing is downloaded**
  beyond this package — no Electron runtime.
- **Pin on top.** A real Win32 `SetWindowPos` toggle from the top bar, with the resulting state
  **read back** to confirm it actually applied.
- **Exact client-area sizing.** The window is corrected after launch to a **520×720 client
  area** (DPI-independent — the frame-minus-client delta is measured at runtime, not hardcoded).
- **Authenticated startup.** A one-shot loopback service sets a session cookie and redirects to
  DSH, so the mini window opens **already logged in**. The isolated profile lives under
  `~/.dsh/dsh-mini-window-browser`; **your own browser profile is never touched.**
- **`DSH_MINI_BROWSER`** environment variable to point at a specific browser executable.
  If it is set but the file is missing, the plugin **fails explicitly** instead of silently
  falling back.
- **Companion parity.** The mini window seeds the plugin/onboarding localStorage state so plugin
  overlays and first-run prompts do not pop up inside the mini window.

### Changed

- **`README.md` rewritten** (both the GitHub root and the npm package) around the new
  install-and-click story, with the requirements and trade-offs stated up front.
- **Removed a duplicate layout offset.** The plugin had been adding `padding-top: 55px` to the
  DSH conversation header *and* adding the same offset to `body`. Because the header is
  `position: static`, the `body` offset already pushed it down — so the second one was pure
  waste. Measured effect of removing it: content top **176px → 131px**, usable height
  **560px → 605px** (82.2% → 88.8% of the viewport). The native DSH padding is left untouched.

### Fixed

- Pin button did nothing in browser mode (it only drove the Electron path).
- Pin could be applied to the wrong window; it now iterates all candidate windows.
- Pin reported success without verifying — it now reads the state back after a delay
  (`SetWindowPos` is asynchronous across processes; reading immediately returns the old value).
- The `/boot` page could hang: it was 103,100 bytes, 99.5% of which was inlined localStorage
  seed (~3,033 keys). It is now **390 bytes**, with the seed trimmed to the keys that actually
  matter and moved to an external script with a native meta-refresh fallback.

### Known limitations

- App mode keeps the **system title bar** (unlike Electron's `frame:false`). Removing it would
  require shipping Electron again, which contradicts the zero-download goal.
- **Chrome or Edge must be installed.** If neither is found the plugin reports an explicit
  error rather than doing nothing.
- Windows-only for the window-management features (`SetWindowPos` for pin); the in-page
  `?dsh-mini=1` layout itself is platform-independent.

---

## 0.1.0 — 2026-10-11

First public release.

- `?dsh-mini=1` — compact single-column conversation view; **zero impact** when the parameter
  is absent (all rules scoped under `html[data-dsh-mini]`).
- Pure client plugin: zero runtime dependencies, no build step, no third-party plugins.
- Draggable floating ball with edge snapping and position memory.
- Top-bar controls: minimize / pin / sidebar toggle / compact float / more menu (80%–150% zoom).

---

> Note: the earlier `companion/` Electron process (tray icon + window that outlives the page)
> is still in the GitHub repository but is **not published to npm** and **no longer required**.
> It costs ~151 MB to build.
