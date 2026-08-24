'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveJamendoClientId: (clientId) => ipcRenderer.invoke('settings:save', clientId),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
});
