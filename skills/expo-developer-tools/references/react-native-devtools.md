---
title: React Native DevTools
summary: the panels behind "Open DevTools" (Console, Sources, Network, Memory, Performance, Components, Profiler), what each shows and how an agent reads it
status: stub
sources:
  - https://reactnative.dev/docs/react-native-devtools (the DevTools panels)
  - https://docs.expo.dev/debugging/tools/ (Open DevTools; the Network panel's Expo/version note)
---

# React Native DevTools

Reference for **expo-developer-tools**.

TODO. The panels: Console (live expressions, preserve logs, JS eval), Sources (breakpoints,
logpoints, scope/call-stack while paused), Network (fetch/XHR/Image, initiators, and its limits: no
WebSocket/mocking/throttling; the version and Expo notes), Memory (heap snapshots, allocation
timeline), Performance (unified timeline, RN 0.83+), Components (the React tree, read/modify
props/state, the Memo badge, highlight-updates), and Profiler (flame graphs, commits, render
durations). Distinguish the Performance panel from the React Profiler. Primary sources only; prior-art
skills are never a source.
