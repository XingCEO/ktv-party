# 🎤 KTV Box — 個人/Demo 家庭點唱系統

> 一台筆電 + 電視 + 多支手機 = 自建 KTV 包廂。
> 支援 YouTube 搜尋點歌、原唱/伴奏切換、即時歌詞、多人同房、氣氛特效、計費計時。

## 架構

```
┌────────┐      WS / REST       ┌────────────┐      yt-dlp / demucs / lrclib
│ Phone  │ ───────────────────▶ │ FastAPI    │ ─────────────────────────────▶ Internet
│ /m/:id │                      │  :8000     │
└────────┘                      │            │
                                │  SQLite    │
┌────────┐                      │  + worker  │
│ TV     │ ◀─── HLS/MP4 ─────── │            │
│ /tv/:id│                      └────────────┘
└────────┘
```

- **Backend** (`api/`) — FastAPI + SQLite + asyncio Demucs worker
- **Frontend** (`web/`) — Next.js 14 App Router + Tailwind + framer-motion
- **Data** (`data/`) — videos / instrumentals / subs / lyrics / cookies / SQLite

---

## 快速啟動 (本機開發)

### 0. 系統需求

- **Windows 10/11**, **macOS**, 或 **Linux**
- **Python 3.11 或 3.12** (Demucs/PyTorch 尚未支援 3.14)
- **Node.js 20+**
- **ffmpeg** (建議),或使用內建 `imageio-ffmpeg`
- (選用) **NVIDIA GPU + CUDA 12.x** — 若要本地伴奏分離

### 1. 安裝相依

```pwsh
# Backend
cd api
pip install -r requirements.txt

# (選用) 啟用 Demucs 伴奏分離
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
pip install demucs

# Frontend
cd ..\web
npm install
```

### 2. (重要) 提供 YouTube cookies

YouTube 對未登入流量限速嚴格。請使用 [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookies-txt-locally) 之類擴充功能,匯出 `youtube.com` cookies 為 Netscape 格式,放到:

```
data/cookies.txt
```

> 沒有 cookies 仍可運作,但搜尋與下載速率會明顯受限,且影片可能被擋。

### 3. 啟動

```pwsh
# 一鍵啟動兩個視窗
.\scripts\dev.ps1

# 或手動
cd api;   python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
cd web;   npm run dev
```

打開瀏覽器:**http://localhost:3000/** 建立第一間包廂。

### 4. 手機連線

電視畫面右上會顯示 **QR Code**。手機掃描 → 直接進入點歌頁。  
若手機掃不到,確認電腦防火牆允許 3000/8000 連入,並確認與手機同一個 WiFi。  
列出可用 LAN IP:

```pwsh
.\scripts\lan-ip.ps1
```

---

## Docker 部署

```bash
docker compose up --build
```

打開:
- TV: <http://localhost:3000/>
- API: <http://localhost:8000/healthz>

> ⚠️ Docker 預設 Demucs 為 CPU build,分離一首歌約 2-5 分鐘。GPU build 需自行修改 Dockerfile。

---

## 主要功能

| 功能 | 路徑 | 備註 |
| --- | --- | --- |
| 建立包廂 | `/` | 自訂名稱 + 計費費率 |
| TV 顯示 | `/tv/:roomId` | 自動播放 + 歌詞 + QR |
| 手機點歌 | `/m/:roomId` | 搜尋 + 點播 + 移除自己歌 |
| 公平輪換 | 自動 | 多人各自佇列輪流播 |
| 原唱 / 消音 | 點歌時切換 | Demucs 後台分離,完成自動切換 |
| 氣氛按鈕 | 手機底部 | 拍手 / 彩帶 / 煙火 / 生日 (TV 即時顯示) |
| 計費 | TV 右上 | 開始 / 重置 + 即時換算 |

---

## 測試

### Backend (pytest, 26 tests)

```pwsh
cd api
python -m pytest -v
```

### Frontend (vitest)

```pwsh
cd web
npm run test
```

### E2E (Playwright,選用)

```pwsh
cd web
npx playwright install
npm run e2e
```

---

## 手動 QA Checklist

> 受限於環境(yt-dlp 對 YouTube 有頻率限制 + Demucs 模型大),以下需要使用者實機驗證:

- [ ] 兩支手機輪流點歌,佇列符合公平輪換 (A/B/A/B)
- [ ] YouTube 搜尋實際回傳結果 + 縮圖正常
- [ ] 點歌後 TV 自動播放,接下一首順暢
- [ ] 切換「消音」模式 → 等待 Demucs 完成 → 影片自動靜音 + 伴奏對齊播放
- [ ] 手機按氣氛鍵 → TV 立刻出現對應特效
- [ ] 計費計時正確(每分鐘按 rate 累加)
- [ ] 中斷網路再恢復 → WebSocket 自動重連 → snapshot 同步狀態

---

## 環境變數

| Var | Default | 說明 |
| --- | --- | --- |
| `KTV_DATA_DIR` | `./data` | 媒體 + DB 目錄 |
| `KTV_DB_PATH` | `$DATA/ktv.db` | SQLite 路徑 |
| `KTV_COOKIES` | `$DATA/cookies.txt` | yt-dlp cookies |
| `KTV_ENABLE_DEMUCS` | `1` | 設 `0` 完全停用伴奏分離 |
| `KTV_DEMUCS_MODEL` | `htdemucs` | 模型名 |
| `KTV_YTDLP_MIN_INTERVAL` | `2.0` | yt-dlp 呼叫最小間隔 (秒) |
| `KTV_CACHE_LIMIT_GB` | `10` | 影片 LRU 上限 |
| `KTV_CORS_ORIGINS` | `*` | API CORS |
| `NEXT_PUBLIC_API_BASE` | (空,同源) | 前端 → 後端 base URL |

---

## 已知限制 / Caveats

- **Python 3.14**:PyTorch 尚未發行 3.14 wheels;Demucs 在 3.14 環境會被自動跳過(系統仍可用,只是無消音功能)。建議用 3.12 venv。
- **Windows 路徑**:資料庫與快取需有寫入權限;若 `C:\` 受限請設 `KTV_DATA_DIR`。
- **YouTube ToS**:本專案僅供個人/家庭學習研究使用,請勿商用。
- **無多店面 / 多帳號 / 付款流程**:刻意精簡,只專注於 Demo 體驗。

---

## 開發筆記

- 後端服務模組 (`api/app/services/`) 全部以 `from ..config` 相對 import,測試時使用 `KTV_DB_PATH` 環境變數隔離。
- 全部跑在單 process 內(asyncio),Demucs 用 `asyncio.Queue` 排隊呼叫子程序,避免 GPU OOM。
- WebSocket 事件詞彙集中在 `api/app/ws.py` 與 `web/lib/ws.ts`,新增事件兩邊請同步。

---

## License

Personal / educational use only. No warranty.
