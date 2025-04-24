/* eslint-disable */
const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded');

    // 버튼 요소 가져오기
    const minimizeBtn = document.getElementById('minimize-btn');
    const maximizeBtn = document.getElementById('maximize-btn');
    const closeBtn = document.getElementById('close-btn');
    const themeToggleBtn = document.getElementById('theme-toggle');

    // 아이콘 요소 가져오기
    const themeIcon = document.getElementById('theme-icon');
    const maximizeIcon = document.getElementById('maximize-icon');
    const restoreIcon = document.getElementById('restore-icon');

    console.log({
        minimizeBtn: !!minimizeBtn,
        maximizeBtn: !!maximizeBtn,
        closeBtn: !!closeBtn,
        themeIcon: !!themeIcon,
        maximizeIcon: !!maximizeIcon,
        restoreIcon: !!restoreIcon,
    });

    // 아이콘 초기화
    lucide.createIcons({
        attrs: {
            width: '14px',
            height: '14px',
            'stroke-width': '1.5',
        },
    });

    // 이벤트 핸들러 설정
    document.querySelector('.title-bar').addEventListener('dblclick', () => {
        ipcRenderer.send('title-bar-double-click');
    });

    minimizeBtn.addEventListener('click', () => {
        ipcRenderer.send('minimize-window');
    });

    maximizeBtn.addEventListener('click', () => {
        ipcRenderer.send('maximize-window');
    });

    closeBtn.addEventListener('click', () => {
        ipcRenderer.send('close-window');
    });

    themeToggleBtn.addEventListener('click', () => {
        ipcRenderer.send('toggle-theme');
    });

    // 창 상태 변경 처리
    function handleWindowStateChange(state) {
        console.log(`Window state changed to: ${state}`);

        if (state === 'maximized') {
            maximizeIcon.style.display = 'none';
            restoreIcon.style.display = 'inline-flex';
            maximizeBtn.title = 'Restore';
        } else {
            maximizeIcon.style.display = 'inline-flex';
            restoreIcon.style.display = 'none';
            maximizeBtn.title = 'Maximize';
        }
    }

    // 테마 변경 처리
    function handleThemeChange(isDark) {
        themeIcon.setAttribute('data-lucide', isDark ? 'moon' : 'sun');
        lucide.createIcons({
            selector: '.theme-icon',
            attrs: {
                width: '14px',
                height: '14px',
                'stroke-width': '1.5',
            },
        });

        if (isDark) {
            document.documentElement.classList.remove('theme-light');
        } else {
            document.documentElement.classList.add('theme-light');
        }
    }

    // 타이틀 업데이트 처리
    function handleTitleUpdate(title) {
        document.getElementById('title-text').textContent = title || 'SoundCloud RPC';
    }

    // 이벤트 리스너 등록
    ipcRenderer.on('theme-changed', (_, isDark) => {
        console.log(`Theme changed to: ${isDark ? 'dark' : 'light'}`);
        handleThemeChange(isDark);
    });

    ipcRenderer.on('window-state-changed', (_, state) => {
        console.log(`Received window state: ${state}`);
        handleWindowStateChange(state);
    });

    ipcRenderer.on('update-title', (_, title) => {
        handleTitleUpdate(title);
    });

    // 초기 상태 요청
    ipcRenderer.send('get-initial-state');
});
