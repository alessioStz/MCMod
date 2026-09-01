'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  config: {
    get: call('config:get'),
    set: call('config:set'),
    pickMcDir: call('dialog:pickMcDir')
  },
  fabric: {
    gameVersions: call('fabric:gameVersions'),
    loaderVersions: call('fabric:loaderVersions'),
    recommendedLoader: call('fabric:recommendedLoader'),
    installedProfiles: call('fabric:installedProfiles'),
    isInstalled: call('fabric:isInstalled'),
    install: call('fabric:install')
  },
  modrinth: {
    search: call('modrinth:search'),
    project: call('modrinth:project'),
    versions: call('modrinth:versions'),
    availability: call('modrinth:availability')
  },
  mods: {
    list: call('mods:list'),
    install: call('mods:install'),
    remove: call('mods:remove'),
    clear: call('mods:clear'),
    snapshot: call('mods:snapshot'),
    checkUpdates: call('mods:checkUpdates'),
    openFolder: call('mods:openFolder')
  },
  lists: {
    all: call('lists:all'),
    create: call('lists:create'),
    update: call('lists:update'),
    remove: call('lists:delete'),
    addMod: call('lists:addMod'),
    removeMod: call('lists:removeMod'),
    exportList: call('lists:export'),
    importList: call('lists:import')
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', { url }),

  onProgress: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('mods:progress', listener);
    return () => ipcRenderer.off('mods:progress', listener);
  },
  onTheme: (handler) => {
    const listener = (_e, theme) => handler(theme);
    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.off('theme:changed', listener);
  }
});
