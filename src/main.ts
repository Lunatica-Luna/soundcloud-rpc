import * as Store from 'electron-store';

import { ElectronBlocker, fullLists } from '@cliqz/adblocker-electron';
import { app, BrowserView, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

import { Client as DiscordClient } from '@xhayper/discord-rpc';
import { ActivityType } from 'discord-api-types/v10';

import {
    authenticateLastFm,
    scrobbleTrack,
    shouldScrobble,
    timeStringToSeconds,
    updateNowPlaying,
} from './lastfm/lastfm';

import type { ScrobbleState } from './lastfm/lastfm';
import { setupLastFmConfig } from './lastfm/lastfm-auth';

import fetch from 'cross-fetch';
import { setupDarwinMenu } from './macos/menu';
import { NotificationManager } from './notifications/notificationManager';

import * as localShortcuts from 'electron-localshortcut';
import * as prompt from 'electron-prompt';
import { autoUpdater } from 'electron-updater';
import * as windowStateManager from 'electron-window-state';
const clientId = '1090770350251458592';
const store = new Store();

export interface Info {
    rpc: DiscordClient;
    ready: boolean;
    autoReconnect: boolean;
}

const info: Info = {
    rpc: new DiscordClient({
        clientId,
    }),
    ready: false,
    autoReconnect: true,
};

info.rpc.login().catch(console.error);

let mainWindow: BrowserWindow | null;
let headerView: BrowserView | null;
let contentView: BrowserView | null;
let blocker: ElectronBlocker;
let currentScrobbleState: ScrobbleState | null = null;
let notificationManager: NotificationManager;
let currentTrackTitle = '';
let isDarkTheme = true;

const displayWhenIdling = false; // Whether to display a status message when music is paused
const displaySCSmallIcon = false; // Whether to display the small SoundCloud logo

function setupUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', () => {
        injectToastNotification('Update Available');
    });

    autoUpdater.on('update-downloaded', () => {
        injectToastNotification('Update Completed');
    });

    autoUpdater.checkForUpdates();
}

async function init() {
    setupUpdater();

    if (process.platform === 'darwin') setupDarwinMenu();
    else Menu.setApplicationMenu(null);

    const windowState = windowStateManager({ defaultWidth: 1280, defaultHeight: 720 });

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        minWidth: 1280,
        minHeight: 720,
        x: windowState.x,
        y: windowState.y,
        frame: false,
        webPreferences: {
            nodeIntegration: false,
        },
        backgroundColor: '#121212',
        useContentSize: true,
    });

    notificationManager = new NotificationManager(mainWindow);

    windowState.manage(mainWindow);

    // Create header view
    headerView = new BrowserView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    mainWindow.addBrowserView(headerView);
    headerView.setBounds({ x: 0, y: 0, width: mainWindow.getBounds().width, height: 32 });
    headerView.setAutoResize({ width: true, height: false });
    headerView.webContents.loadFile(path.join(__dirname, 'header', 'header.html'));

    // Create content view for SoundCloud
    contentView = new BrowserView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    mainWindow.addBrowserView(contentView);
    contentView.setBounds({
        x: 0,
        y: 32,
        width: mainWindow.getBounds().width,
        height: mainWindow.getBounds().height - 32,
    });
    contentView.setAutoResize({ width: true, height: true });

    contentView.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Setup window control handlers
    setupWindowControls();

    // Setup theme handlers
    setupThemeHandlers();

    // Setup proxy
    if (store.get('proxyEnabled')) {
        const { protocol, host } = store.get('proxyData') as { protocol: string; host: string };

        await contentView.webContents.session.setProxy({
            proxyRules: `${protocol}//${host}`,
        });
    }

    // Load the SoundCloud website
    contentView.webContents.loadURL('https://soundcloud.com/discover');

    const executeJS = (script: string) => contentView.webContents.executeJavaScript(script);

    // Wait for the page to fully load
    contentView.webContents.on('did-finish-load', async () => {
        const apikey = store.get('lastFmApiKey');
        const secret = store.get('lastFmSecret');

        if (apikey && secret && contentView.webContents.getURL().startsWith('https://soundcloud.com/')) {
            await authenticateLastFm(mainWindow, store);
            injectToastNotification('Last.fm authenticated');
        }

        // Apply theme to content
        applyThemeToContent(isDarkTheme);

        if (store.get('adBlocker')) {
            const blocker = await ElectronBlocker.fromLists(
                fetch,
                fullLists,
                { enableCompression: true },
                {
                    path: 'engine.bin',
                    read: async (...args) => readFileSync(...args),
                    write: async (...args) => writeFileSync(...args),
                }
            );
            blocker.enableBlockingInSession(contentView.webContents.session);
        }

        setInterval(async () => {
            try {
                const isPlaying = await executeJS(`
                    document.querySelector('.playControls__play').classList.contains('playing')
                `);

                if (isPlaying) {
                    const trackInfo = await executeJS(`
                    new Promise(resolve => {
                        const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
                        const authorEl = document.querySelector('.playbackSoundBadge__lightLink');
                        resolve({
                            title: titleEl?.innerText ?? '',
                            author: authorEl?.innerText ?? ''
                        });
                    });
                `);
                    if (!trackInfo.title || !trackInfo.author) {
                        console.log('Incomplete track info:', trackInfo);
                        return;
                    }

                    const currentTrack = {
                        author: trackInfo.author as string,
                        title: trackInfo.title
                            .replace(/.*?:\s*/, '') // Remove everything up to and including the first colon.
                            .replace(/\n.*/, '') // Remove everything after the first newline.
                            .trim() as string, // Clean up any leading/trailing spaces.
                    };

                    // Update title in header
                    currentTrackTitle = `${currentTrack.title} - ${currentTrack.author}`;
                    if (headerView) {
                        headerView.webContents.send('update-title', currentTrackTitle);
                    }

                    const artworkUrl = await executeJS(`
                    new Promise(resolve => {
                        const artworkEl = document.querySelector('.playbackSoundBadge__avatar .image__lightOutline span');
                        resolve(artworkEl ? artworkEl.style.backgroundImage.slice(5, -2) : '');
                    });
                `);

                    const [elapsedTime, totalTime] = await Promise.all([
                        executeJS(
                            `document.querySelector('.playbackTimeline__timePassed span:last-child')?.innerText ?? ''`
                        ),
                        executeJS(
                            `document.querySelector('.playbackTimeline__duration span:last-child')?.innerText ?? ''`
                        ),
                    ]); //;

                    await updateNowPlaying(currentTrack, store);

                    const parseTime = (time: string): number => {
                        const parts = time.split(':').map(Number);
                        return parts.reduce((acc, part) => 60 * acc + part, 0) * 1000;
                    };

                    const elapsedMilliseconds = parseTime(elapsedTime);
                    const totalMilliseconds = parseTime(totalTime);

                    if (
                        !currentScrobbleState ||
                        currentScrobbleState.artist !== currentTrack.author ||
                        currentScrobbleState.title !== currentTrack.title
                    ) {
                        // Scrobble previous track if it wasn't scrobbled and met criteria
                        if (
                            currentScrobbleState &&
                            !currentScrobbleState.scrobbled &&
                            shouldScrobble(currentScrobbleState)
                        ) {
                            await scrobbleTrack(
                                {
                                    author: currentScrobbleState.artist,
                                    title: currentScrobbleState.title,
                                },
                                store
                            );
                        }

                        // Start tracking new track
                        currentScrobbleState = {
                            artist: currentTrack.author,
                            title: currentTrack.title,
                            startTime: Date.now(),
                            duration: timeStringToSeconds(trackInfo.duration),
                            scrobbled: false,
                        };
                    } else if (
                        currentScrobbleState &&
                        !currentScrobbleState.scrobbled &&
                        shouldScrobble(currentScrobbleState)
                    ) {
                        // Scrobble current track if it meets criteria
                        await scrobbleTrack(
                            {
                                author: currentScrobbleState.artist,
                                title: currentScrobbleState.title,
                            },
                            store
                        );
                        currentScrobbleState.scrobbled = true;
                    }

                    if (!info.rpc.isConnected) {
                        if (await !info.rpc.login().catch(console.error)) {
                            return;
                        }
                    }

                    info.rpc.user?.setActivity({
                        type: ActivityType.Listening,
                        details: `${shortenString(currentTrack.title)}${currentTrack.title.length < 2 ? '⠀⠀' : ''}`,
                        state: `${shortenString(trackInfo.author)}${trackInfo.author.length < 2 ? '⠀⠀' : ''}`,
                        largeImageKey: artworkUrl.replace('50x50.', '500x500.'),
                        startTimestamp: Date.now() - elapsedMilliseconds,
                        endTimestamp: Date.now() + (totalMilliseconds - elapsedMilliseconds),
                        smallImageKey: displaySCSmallIcon ? 'soundcloud-logo' : '',
                        smallImageText: displaySCSmallIcon ? 'SoundCloud' : '',
                        instance: false,
                    });
                } else if (displayWhenIdling) {
                    info.rpc.user?.setActivity({
                        details: 'Listening to SoundCloud',
                        state: 'Paused',
                        largeImageKey: 'idling',
                        largeImageText: 'Paused',
                        smallImageKey: 'soundcloud-logo',
                        smallImageText: 'SoundCloud',
                        instance: false,
                    });

                    // Reset title
                    currentTrackTitle = 'SoundCloud RPC';
                    if (headerView) {
                        headerView.webContents.send('update-title', currentTrackTitle);
                    }
                } else {
                    info.rpc.user?.clearActivity();

                    // Reset title
                    currentTrackTitle = 'SoundCloud RPC';
                    if (headerView) {
                        headerView.webContents.send('update-title', currentTrackTitle);
                    }
                }
            } catch (error) {
                console.error('Error during RPC update:', error);
            }
        }, 5000);
    });

    // Emitted when the window is closed.
    mainWindow.on('close', function () {
        store.set('bounds', mainWindow.getBounds());
        store.set('maximazed', mainWindow.isMaximized());
        store.set('theme', isDarkTheme ? 'dark' : 'light');
    });

    mainWindow.on('closed', function () {
        mainWindow = null;
        headerView = null;
        contentView = null;
    });

    // Resize content view when window is resized
    mainWindow.on('resize', () => {
        if (mainWindow && contentView) {
            const bounds = mainWindow.getBounds();
            contentView.setBounds({ x: 0, y: 32, width: bounds.width, height: bounds.height - 32 });
        }
    });

    // Register shortcuts
    setupShortcuts();
}

function setupWindowControls() {
    if (!mainWindow) return;

    // 헤더의 높이
    const HEADER_HEIGHT = 32;

    ipcMain.on('minimize-window', () => {
        if (mainWindow) mainWindow.minimize();
    });

    ipcMain.on('maximize-window', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    });

    // contentView와 headerView의 크기와 위치를 조정하는 함수
    function adjustContentViews() {
        if (!mainWindow || !contentView || !headerView) return;

        const { width, height } = mainWindow.getContentBounds();

        // 헤더 뷰 설정
        headerView.setBounds({
            x: 0,
            y: 0,
            width,
            height: HEADER_HEIGHT,
        });

        // 컨텐츠 뷰 설정 (헤더 아래에 위치)
        contentView.setBounds({
            x: 0,
            y: HEADER_HEIGHT,
            width,
            height: height - HEADER_HEIGHT,
        });
    }

    ipcMain.on('title-bar-double-click', () => {
        // 타이틀바 더블클릭 시 최대화/복원 토글
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    });

    // 창 최대화/복원 상태 변경 감지 및 렌더러에 알림
    mainWindow.on('maximize', () => {
        console.log('Window maximized');
        if (headerView) {
            headerView.webContents.send('window-state-changed', 'maximized');
        }
        adjustContentViews();
    });

    mainWindow.on('unmaximize', () => {
        console.log('Window unmaximized');
        if (headerView) {
            headerView.webContents.send('window-state-changed', 'normal');
        }
        adjustContentViews();
    });

    // 크기 변경 시 컨텐츠 영역 조정
    mainWindow.on('resize', () => {
        adjustContentViews();
    });

    ipcMain.on('close-window', () => {
        if (mainWindow) mainWindow.close();
    });

    ipcMain.on('get-initial-state', () => {
        if (headerView) {
            headerView.webContents.send('theme-changed', isDarkTheme);
            headerView.webContents.send('update-title', currentTrackTitle || 'SoundCloud RPC');
            headerView.webContents.send('window-state-changed', mainWindow.isMaximized() ? 'maximized' : 'normal');
        }
    });

    // 초기 컨텐츠 뷰 조정
    adjustContentViews();
}

function setupThemeHandlers() {
    // Load theme preference
    isDarkTheme = store.get('theme') !== 'light';

    ipcMain.on('toggle-theme', () => {
        isDarkTheme = !isDarkTheme;
        if (headerView) {
            headerView.webContents.send('theme-changed', isDarkTheme);
        }
        applyThemeToContent(isDarkTheme);
    });
}

function applyThemeToContent(isDark: boolean) {
    if (!contentView) return;

    const themeScript = `
        (function() {
            // SoundCloud의 기존 테마 클래스 제거
            document.body.classList.remove('${isDark ? 'theme-light' : 'theme-dark'}');
            document.body.classList.add('${isDark ? 'theme-dark' : 'theme-light'}');
            
            // CSS 변수 접근이 가능한 경우 직접 테마 색상 설정
            try {
                // 테마 색상을 직접 설정
                if (${isDark}) {
                    document.documentElement.style.setProperty('--background-base', '#121212');
                    document.documentElement.style.setProperty('--background-surface', '#212121');
                    document.documentElement.style.setProperty('--text-base', '#ffffff');
                } else {
                    document.documentElement.style.setProperty('--background-base', '#ffffff');
                    document.documentElement.style.setProperty('--background-surface', '#f2f2f2');
                    document.documentElement.style.setProperty('--text-base', '#333333');
                }
                
                // 스크롤바 스타일 추가
                const style = document.createElement('style');
                style.id = 'custom-scrollbar-style';
                style.textContent = \`
                    /* 기존 스크롤바 숨기기 */
                    ::-webkit-scrollbar-button {
                        display: none;
                    }
                    
                    /* 스크롤바 기본 스타일 */
                    ::-webkit-scrollbar {
                        width: 8px;
                        height: 8px;
                        background-color: ${isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)'};
                    }
                    
                    /* 스크롤바 트랙 */
                    ::-webkit-scrollbar-track {
                        background-color: transparent;
                    }
                    
                    /* 스크롤바 썸 (이동 부분) */
                    ::-webkit-scrollbar-thumb {
                        background-color: ${isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)'};
                        border-radius: 4px;
                        transition: background-color 0.3s;
                    }
                    
                    /* 스크롤바 호버 효과 */
                    ::-webkit-scrollbar-thumb:hover {
                        background-color: ${isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)'};
                    }
                    
                    /* 코너 스타일 */
                    ::-webkit-scrollbar-corner {
                        background-color: transparent;
                    }
                \`;
                
                // 기존 스타일이 있으면 제거하고 새로운 스타일 추가
                const existingStyle = document.getElementById('custom-scrollbar-style');
                if (existingStyle) {
                    existingStyle.remove();
                }
                document.head.appendChild(style);
            } catch(e) {
                console.error('테마 CSS 변수 설정 실패:', e);
            }
        })();
    `;

    contentView.webContents.executeJavaScript(themeScript).catch(console.error);
}

function setupShortcuts() {
    if (!mainWindow || !contentView) return;

    // 웹 콘텐츠에 키보드 단축키 적용
    contentView.webContents.on('before-input-event', (event, input) => {
        // F12: 개발자 도구
        if (input.key === 'F12' && !input.alt && !input.control && !input.meta && !input.shift) {
            contentView.webContents.openDevTools({ mode: 'detach' });
            event.preventDefault();
        }

        // F2: 광고 차단기 토글
        if (input.key === 'F2' && !input.alt && !input.control && !input.meta && !input.shift) {
            toggleAdBlocker();
            event.preventDefault();
        }

        // F3: 프록시 설정
        if (input.key === 'F3' && !input.alt && !input.control && !input.meta && !input.shift) {
            toggleProxy();
            event.preventDefault();
        }

        // F4: Last.fm 인증
        if (input.key === 'F4' && !input.alt && !input.control && !input.meta && !input.shift) {
            const apikey = store.get('lastFmApiKey');
            const secret = store.get('lastFmSecret');
            if (!apikey || !secret) {
                setupLastFmConfig(mainWindow, store);
            } else {
                authenticateLastFm(mainWindow, store);
                injectToastNotification('Last.fm authenticated');
            }
            event.preventDefault();
        }

        // F6: Last.fm 설정 삭제
        if (input.key === 'F6' && !input.alt && !input.control && !input.meta && !input.shift) {
            store.delete('lastFmApiKey');
            store.delete('lastFmSecret');
            contentView.webContents.reload();
            event.preventDefault();
        }

        // 확대 (Ctrl+=)
        if (input.key === '=' && input.control && !input.alt && !input.meta && !input.shift) {
            const zoomLevel = contentView.webContents.getZoomLevel();
            contentView.webContents.setZoomLevel(Math.min(zoomLevel + 1, 9));
            event.preventDefault();
        }

        // 축소 (Ctrl+-)
        if (input.key === '-' && input.control && !input.alt && !input.meta && !input.shift) {
            const zoomLevel = contentView.webContents.getZoomLevel();
            contentView.webContents.setZoomLevel(Math.max(zoomLevel - 1, -9));
            event.preventDefault();
        }

        // 기본 확대/축소 (Ctrl+0)
        if (input.key === '0' && input.control && !input.alt && !input.meta && !input.shift) {
            contentView.webContents.setZoomLevel(0);
            event.preventDefault();
        }

        // 뒤로 가기 (Ctrl+B 또는 Ctrl+P)
        if ((input.key === 'b' || input.key === 'p') && input.control && !input.alt && !input.meta && !input.shift) {
            if (contentView.webContents.canGoBack()) {
                contentView.webContents.goBack();
            }
            event.preventDefault();
        }

        // 앞으로 가기 (Ctrl+F 또는 Ctrl+N)
        if ((input.key === 'f' || input.key === 'n') && input.control && !input.alt && !input.meta && !input.shift) {
            if (contentView.webContents.canGoForward()) {
                contentView.webContents.goForward();
            }
            event.preventDefault();
        }
    });

    // 단축키 등록은 유지 (직접적인 콘텐츠 조작은 위의 이벤트 핸들러로 이동)
    localShortcuts.register(mainWindow, 'F2', () => toggleAdBlocker());
    localShortcuts.register(mainWindow, 'F12', () => {
        if (contentView) contentView.webContents.openDevTools({ mode: 'detach' });
    });
    localShortcuts.register(mainWindow, 'F3', async () => toggleProxy());
    localShortcuts.register(mainWindow, 'F4', async () => {
        const apikey = store.get('lastFmApiKey');
        const secret = store.get('lastFmSecret');
        if (!apikey || !secret) {
            await setupLastFmConfig(mainWindow, store);
        } else {
            await authenticateLastFm(mainWindow, store);
            injectToastNotification('Last.fm authenticated');
        }
    });
    localShortcuts.register(mainWindow, 'F6', async () => {
        store.delete('lastFmApiKey');
        store.delete('lastFmSecret');
        if (contentView) contentView.webContents.reload();
    });

    // 확대/축소
    localShortcuts.register(mainWindow, 'CmdOrCtrl+=', () => {
        if (!contentView) return;
        const zoomLevel = contentView.webContents.getZoomLevel();
        contentView.webContents.setZoomLevel(Math.min(zoomLevel + 1, 9));
    });
    localShortcuts.register(mainWindow, 'CmdOrCtrl+-', () => {
        if (!contentView) return;
        const zoomLevel = contentView.webContents.getZoomLevel();
        contentView.webContents.setZoomLevel(Math.max(zoomLevel - 1, -9));
    });
    localShortcuts.register(mainWindow, 'CmdOrCtrl+0', () => {
        if (!contentView) return;
        contentView.webContents.setZoomLevel(0);
    });

    // 뒤로/앞으로 가기
    localShortcuts.register(mainWindow, ['CmdOrCtrl+B', 'CmdOrCtrl+P'], () => {
        if (contentView && contentView.webContents.canGoBack()) contentView.webContents.goBack();
    });
    localShortcuts.register(mainWindow, ['CmdOrCtrl+F', 'CmdOrCtrl+N'], () => {
        if (contentView && contentView.webContents.canGoForward()) contentView.webContents.goForward();
    });

    // 메인 윈도우의 키보드 이벤트도 추가로 리스닝
    mainWindow.webContents.on('before-input-event', (event, input) => {
        // 키보드 이벤트를 contentView로 전달
        if (contentView) {
            contentView.webContents.sendInputEvent({
                type: input.type === 'keyDown' ? 'keyDown' : 'keyUp',
                keyCode: input.key,
                modifiers: [],
            });
        }
    });
}

// When Electron has finished initializing, create the main window
app.on('ready', init);

// Quit the app when all windows are closed, unless running on macOS (where it's typical to leave apps running)
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// When the app is activated, create the main window if it doesn't already exist
app.on('activate', function () {
    if (mainWindow === null) {
        init();
    }
});

//Function to toggle the adblocker
function toggleAdBlocker() {
    const adBlockEnabled = store.get('adBlocker');
    store.set('adBlocker', !adBlockEnabled);

    if (adBlockEnabled) {
        if (blocker && contentView) blocker.disableBlockingInSession(contentView.webContents.session);
    }

    if (contentView) {
        contentView.webContents.reload();
        injectToastNotification(adBlockEnabled ? 'Adblocker disabled' : 'Adblocker enabled');
    }
}

// Handle proxy authorization
app.on('login', async (_event, _webContents, _request, authInfo, callback) => {
    if (authInfo.isProxy) {
        if (!store.get('proxyEnabled')) {
            return callback('', '');
        }

        const { user, password } = store.get('proxyData') as { user: string; password: string };

        callback(user, password);
    }
});

function shortenString(str: string): string {
    return str.length > 128 ? str.substring(0, 128) + '...' : str;
}

// Function to toggle proxy
async function toggleProxy() {
    const proxyUri = await prompt({
        title: 'Setup Proxy',
        label: "Enter 'off' to disable the proxy",
        value: 'http://user:password@ip:port',
        inputAttrs: {
            type: 'uri',
        },
        type: 'input',
    });

    if (proxyUri === null) return;

    if (proxyUri == 'off') {
        store.set('proxyEnabled', false);

        dialog.showMessageBoxSync(mainWindow, { message: 'The application needs to restart to work properly' });
        app.quit();
    } else {
        try {
            const url = new URL(proxyUri);
            store.set('proxyEnabled', true);
            store.set('proxyData', {
                protocol: url.protocol,
                host: url.host,
                user: url.username,
                password: url.password,
            });
            dialog.showMessageBoxSync(mainWindow, { message: 'The application needs to restart to work properly' });
            app.quit();
        } catch (e) {
            store.set('proxyEnabled', false);
            mainWindow.reload();
            injectToastNotification('Failed to setup proxy.');
        }
    }
}

// Function to inject toast notification into the main page
export function injectToastNotification(message: string) {
    if (mainWindow && notificationManager) {
        notificationManager.show(message);
    }
}
