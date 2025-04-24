import { BrowserView, BrowserWindow, ipcMain } from 'electron';

export class NotificationManager {
    private view: BrowserView;
    private queue: string[] = [];
    private isDisplaying = false;
    private parentWindow: BrowserWindow;
    private headerHeight = 32; // 헤더 높이

    constructor(parentWindow: BrowserWindow) {
        this.parentWindow = parentWindow;
        this.view = new BrowserView({
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                transparent: true,
            },
        });
    }

    public show(message: string): void {
        this.queue.push(message);
        if (!this.isDisplaying) {
            this.displayNext();
        }
    }

    private displayNext(): void {
        if (this.queue.length === 0) {
            this.isDisplaying = false;
            this.parentWindow.removeBrowserView(this.view);
            return;
        }

        this.isDisplaying = true;
        const message = this.queue.shift();
        const bounds = this.parentWindow.getContentBounds(); // contentBounds 사용
        const width = 400;
        const height = 70;

        // 모든 다른 BrowserView 위에 표시되도록 z-index 설정
        this.parentWindow.addBrowserView(this.view);

        // 모든 뷰의 목록 가져오기 (있다면)
        const views = this.parentWindow.getBrowserViews();

        // 알림 뷰를 맨 위로 이동 (마지막에 추가된 뷰가 맨 위에 표시됨)
        if (views.length > 1) {
            for (const view of views) {
                if (view !== this.view) {
                    this.parentWindow.removeBrowserView(view);
                    this.parentWindow.addBrowserView(view);
                }
            }
            // 알림 뷰를 마지막에 추가
            this.parentWindow.addBrowserView(this.view);
        }

        this.view.setBounds({
            x: Math.floor((bounds.width - width) / 2),
            y: bounds.height - height - 120, // 하단에서 120px 위에 표시
            width,
            height,
        });

        const html = `
        <style>
            body {
                margin: 0;
                display: flex;
                justify-content: center;
                align-items: center;
                font-family: 'Pretendard JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background-color: transparent;
                color: white;
                height: 100vh;
                opacity: 0;
                transition: opacity 0.3s ease-in-out;
                overflow: hidden;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
            }
            .notification {
                padding: 15px 25px;
                border-radius: 12px;
                font-size: 16px;
                font-weight: 500;
                text-align: center;
                transform: translateY(0);
                transition: transform 0.3s ease-in-out;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 90%;
                user-select: none;
                -webkit-user-select: none;
                background: rgba(40, 40, 40, 0.9);
                backdrop-filter: blur(8px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }
            body.fade-out .notification {
                transform: translateY(10px);
            }
        </style>
        <body>
            <div class="notification">${message}</div>
            <script>
                setTimeout(() => document.body.style.opacity = '1', 100);
                setTimeout(() => {
                    document.body.classList.add('fade-out');
                    document.body.style.opacity = '0';
                    setTimeout(() => {
                        const { ipcRenderer } = require('electron');
                        ipcRenderer.send('notification-done');
                    }, 300);
                }, 3000); // 조금 빠르게 사라지도록 4500에서 3000으로 변경
            </script>
        </body>`;

        // Set up one-time IPC listener for this notification
        ipcMain.once('notification-done', () => {
            setTimeout(() => this.displayNext(), 100);
        });

        this.view.webContents.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    }
}
