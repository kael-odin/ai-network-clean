// 界面能调用的主进程接口
import { contextBridge, ipcRenderer } from 'electron';
import type { AinApi, AppState } from '../shared/ipc.ts';

const ain: AinApi = {
  state: () => ipcRenderer.invoke('state'),
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  check: () => ipcRenderer.invoke('check'),
  repair: () => ipcRenderer.invoke('repair'),
  diagnose: () => ipcRenderer.invoke('diagnose'),
  protect: () => ipcRenderer.invoke('protect'),
  splitTest: () => ipcRenderer.invoke('split.test'),
  connections: () => ipcRenderer.invoke('connections'),

  setSettings: (patch) => ipcRenderer.invoke('settings.set', patch),
  resetSettings: () => ipcRenderer.invoke('settings.reset'),
  openDataDir: () => ipcRenderer.invoke('data.open'),
  refreshNodes: () => ipcRenderer.invoke('nodes.refresh'),
  testNodes: () => ipcRenderer.invoke('nodes.test'),
  selectNode: (name) => ipcRenderer.invoke('nodes.select', name),

  ccCheck: () => ipcRenderer.invoke('cc.check'),
  ccFix: () => ipcRenderer.invoke('cc.fix'),
  ccUndo: () => ipcRenderer.invoke('cc.undo'),
  claudeRunning: () => ipcRenderer.invoke('claude.running'),
  claudeLaunch: (kind) => ipcRenderer.invoke('claude.launch', kind),
  claudeStatus: () => ipcRenderer.invoke('claude.status'),
  claudeScan: () => ipcRenderer.invoke('claude.scan'),
  claudeClean: (ids, backup) => ipcRenderer.invoke('claude.clean', ids, backup),
  envRecheck: () => ipcRenderer.invoke('env.recheck'),
  lineTest: (line) => ipcRenderer.invoke('line.test', line),
  relaunchAsAdmin: () => ipcRenderer.invoke('relaunchAsAdmin'),
  fpReset: () => ipcRenderer.invoke('fpReset'),
  settingsBackups: () => ipcRenderer.invoke('settings.backups'),
  settingsRestore: (name) => ipcRenderer.invoke('settings.restore', name),
  identities: (deep) => ipcRenderer.invoke('identity.list', deep === true),
  identityCapture: (name) => ipcRenderer.invoke('identity.capture', name),
  identityActivate: (id) => ipcRenderer.invoke('identity.activate', id),
  identityRename: (id, name) => ipcRenderer.invoke('identity.rename', id, name),
  identityRemove: (id) => ipcRenderer.invoke('identity.remove', id),
  identityKillClaude: () => ipcRenderer.invoke('identity.kill'),
  claudeDismiss: () => ipcRenderer.invoke('claude.dismiss'),

  copyDiag: () => ipcRenderer.invoke('diag.copy'),
  copyText: (text) => ipcRenderer.invoke('copy', text),
  exportLog: () => ipcRenderer.invoke('log.export'),
  exportAnomalies: () => ipcRenderer.invoke('anomaly.export'),
  openUrl: (url) => ipcRenderer.invoke('open.url', url),
  showWindow: (page) => ipcRenderer.invoke('win.show', page),
  hideTray: () => ipcRenderer.invoke('tray.hide'),
  quit: () => ipcRenderer.invoke('quit'),

  onState: (cb: (s: AppState) => void) => {
    const handler = (_e: unknown, s: AppState) => cb(s);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  onNav: (cb: (page: string) => void) => {
    const handler = (_e: unknown, p: string) => cb(p);
    ipcRenderer.on('nav', handler);
    return () => ipcRenderer.removeListener('nav', handler);
  },
};

contextBridge.exposeInMainWorld('ain', ain);
