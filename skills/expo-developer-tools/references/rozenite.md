---
title: Rozenite plugins
summary: Rozenite, the React Native DevTools plugin framework, and its official plugins; the escape hatch when a built-in DevTools panel is not enough
status: complete
sources:
  - https://www.rozenite.dev/ (what Rozenite is; auto-appears in DevTools; auto-disabled in production; Expo and bare RN, Metro and Re.Pack)
  - https://www.rozenite.dev/plugin-directory (the official plugin list, verbatim)
---

# Rozenite plugins

Reference for **expo-developer-tools**. Rozenite is a **React Native DevTools plugin framework**:
you install a plugin as an npm package and its panel **auto-appears inside React Native DevTools**,
with no extra window, server, or browser tab. Plugins are **automatically disabled in production
builds**, so no plugin code ships to users. It works with Expo and bare React Native, and with Metro
and Re.Pack. Reach for it when a **built-in DevTools panel is not enough**.

## The official plugins

Grouped by what they add (names verbatim from the plugin directory):

- **Network, beyond the built-in panel**: `@rozenite/network-activity-plugin` (Network Activity).
  The built-in Network panel does not cover WebSocket; this is where richer network inspection lives.
- **State management**: `@rozenite/redux-devtools-plugin` (Redux DevTools) and
  `@rozenite/tanstack-query-plugin` (TanStack Query), for inspecting store and query state the native
  panels cannot see.
- **Storage**: `@rozenite/storage-plugin` (a generic storage inspector), `@rozenite/sqlite-plugin`
  (SQLite), and `@rozenite/file-system-plugin` (browse app files and preview contents).
- **Performance**: `@rozenite/performance-monitor-plugin`.
- **Navigation**: `@rozenite/react-navigation-plugin`.
- **UI development aids**: `rozenite-preview` (select a component in DevTools and preview it live on
  the simulator), `@rozenite/overlay-plugin` (grid and image overlay), and `@rozenite/controls-plugin`
  (expose app-defined controls in DevTools).
- **Expo**: `@rozenite/expo-atlas-plugin` (Expo Atlas, bundle inspection).

The directory is the source of truth for the current set; check it rather than assuming this list is
complete.

## See also

- `react-native-devtools.md`: the built-in panels these plugins extend (and the WebSocket gap in Network).
- `dev-menu.md`: Open DevTools, where these panels appear.
