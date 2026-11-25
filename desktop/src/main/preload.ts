import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopBridge } from "./bridge-types";
import { channels } from "./channels";

function subscribe<T>(channel: string, listener: (value: T) => void) {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => { ipcRenderer.removeListener(channel, wrapped); };
}

const bridge: DesktopBridge = {
  getSettings: () => ipcRenderer.invoke(channels.settingsGet),
  saveSettings: (update) => ipcRenderer.invoke(channels.settingsSave, update),
  runText: (task, input) => ipcRenderer.invoke(channels.textRun, task, input),
  testText: (task) => ipcRenderer.invoke(channels.textTest, task),
  listTextModels: (connection, task) => ipcRenderer.invoke(channels.textModels, connection, task),
  copyDraft: (text) => ipcRenderer.invoke(channels.copyDraft, text),
  testAsr: () => ipcRenderer.invoke(channels.asrTest),
  startAsr: (options) => ipcRenderer.invoke(channels.asrStart, options),
  sendAsrAudio: (pcm) => { ipcRenderer.send(channels.asrAudio, pcm); },
  stopAsr: () => ipcRenderer.invoke(channels.asrStop),
  listMeetingApps: () => ipcRenderer.invoke(channels.meetingList),
  startMeetingAudio: (id) => ipcRenderer.invoke(channels.meetingStart, id),
  stopMeetingAudio: () => ipcRenderer.invoke(channels.meetingStop),
  onAsrEvent: (listener) => subscribe(channels.asrEvent, listener),
  setOverlayOpen: (open) => ipcRenderer.invoke(channels.overlayOpen, open),
  setOverlayCompact: (compact) => ipcRenderer.invoke(channels.overlayCompact, compact),
  setOverlayState: (state) => { ipcRenderer.send(channels.overlayState, state); },
  getOverlayState: () => ipcRenderer.invoke(channels.overlayRead),
  onOverlayState: (listener) => subscribe(channels.overlayState, listener),
  overlayAction: (action) => { ipcRenderer.send(channels.overlayAction, action); },
  onOverlayAction: (listener) => subscribe(channels.overlayAction, listener),
  closeOverlay: () => ipcRenderer.invoke(channels.overlayClose),
};

contextBridge.exposeInMainWorld("auralDesktop", bridge);
