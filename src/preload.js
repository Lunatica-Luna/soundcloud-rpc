/* eslint-disable */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 윈도우 컨트롤
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),

    // 테마
    toggleTheme: () => ipcRenderer.send('toggle-theme'),
    onThemeChanged: (callback) => ipcRenderer.on('theme-changed', (_, value) => callback(value)),

    // 제목
    onTitleUpdate: (callback) => ipcRenderer.on('update-title', (_, value) => callback(value)),

    // 초기 상태
    getInitialState: () => ipcRenderer.send('get-initial-state'),
});
