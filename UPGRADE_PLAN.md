# KTV Box — Upgrade Plan (rebuilt)

> 這份計畫由 Sisyphus 在 ralph loop 結束後重建，反映 CCG 三方合議內容 + 我目前實作的覆蓋面。
> 目的：把「現有結構打磨完美」的成果（已完成）銜接到「重新定義派對體驗」的下一步（規劃中）。

---

## 0. 進度標記

- ✅ Phase A — 現有架構穩定性 + 設計系統化（已完成，Oracle 三輪驗證）
- 🔧 Phase B — 體驗重構（本次計畫，分三波執行）
- ⏳ Phase C — 真實派對驗證（手動 QA，README §141-151）

---

## 1. 兩方共識（已成共識）

| # | 項目 | 狀態 |
|---|---|---|
| 1 | LRU bounded lock cache + 503 backpressure | ✅ |
| 2 | WS broker atomic dead-socket cleanup + heartbeat | ✅ |
| 3 | Demucs worker auto-respawn + queue cap | ✅ |
| 4 | 8-component design system (Button/Input/Card/Badge/Toast/Spinner/IconButton/Skeleton) | ✅ |
| 5 | 三頁全部用 design system 重畫 + Tailwind motion tokens | ✅ |
| 6 | Backend + frontend + e2e pass + production build clean | ✅ |

---

## 2. 衝突仲裁（CCG 兩方意見打架的地方）

| 議題 | Codex 主張 | Gemini 主張 | 仲裁 |
|---|---|---|---|
| 播放控制權歸屬 | server 持權威，TV 是消費者 | TV 直接控制 video element 反應快 | **先骨後肉** — 走 Codex（避免 TV 一閃退卡整夜），但 TV 仍持本地 hint 回報以加速 |
| 過場處理 | server-side 排程 advance | TV 客戶端 5 秒「Up Next」過場動畫 | **兩個都做** — server 主排程，TV 在切換瞬間秀過場（不阻塞 server scheduler） |
| Singer Mode 觸發 | server 標記 `is_singer` flag 推給手機 | 手機本地比對 `user_id === playing.user_id` | **選 Gemini** — server 已 broadcast queue，手機本地比對即可，少一個 RPC |
| 影片佔比 | 9/3 grid 保留 sidebar 給隊列 | 12/12 全螢幕影片，隊列做側拉 | **選 Gemini** — TV 是表演舞台，9/3 浪費 25% |
| 氣氛 combo | 不要做（資料噪音） | 連按 5 次同氣氛觸發 mega effect | **選 Gemini** — 派對體驗值得 |

---

## 3. 三層優先路線

### 必修 8 項（影響穩定性 / bug）

1. ✅ LockCache hard-bound + 503
2. ✅ Server WS heartbeat
3. ✅ Demucs worker respawn
4. ✅ Queue race fix (partial unique index + retry)
5. ✅ ws.ts mixed-content under https tunnel — **本輪剛修**
6. 🔧 **Server-side playback authority** — TV 一閃退不卡整夜（**本輪 Wave 1A**）
7. ⏳ Demucs job rehydration after server restart — 進行中 jobs 應該續做
8. ⏳ yt-dlp 錯誤分類（429 / geoblock / age-gate / private）→ 給用戶人話

### 必做 9 項（體驗重構）

1. 🔧 **Singer Mode** — 唱歌的人手機自動變遙控（**本輪 Wave 1B**）
2. 🔧 **TV 全螢幕影片** — 拿掉 sidebar，QR 縮到角落，隊列改側拉（**本輪 Wave 1B**）
3. 🔧 **5 秒過場** — playback.advanced 時 TV 秀「Up Next」+ 倒數（**本輪 Wave 1B**）
4. ⏳ 氣氛 combo — 連按 5 次同 emoji 觸發 mega effect
5. ⏳ Atmosphere echo dedup — 別把自己送的回送回來
6. ⏳ 歌曲新增動畫 — 隊列項目滑入而非閃現
7. ⏳ 多人房間 presence — 「Bob 加入了」浮現
8. ⏳ Lyric karaoke 模式 — 字隨進度填色（不只整行高亮）
9. ⏳ 結束畫面 — 一首歌結束秀「90 分」假評分增添趣味

### 加分 10 項（未來迭代）

1. ⏳ 包廂計時器到達 X 元自動提醒
2. ⏳ 投票踢歌（>50% 同意 skip）
3. ⏳ 歷史記錄（誰唱過什麼）
4. ⏳ 排行榜（哪首被點最多次）
5. ⏳ Spotify / Apple Music 匯入歌單
6. ⏳ 多語 i18n（en / ja / ko）
7. ⏳ 主題切換（Vegas / 迪斯可 / 古早 KTV）
8. ⏳ Phone-as-mic 模式（用手機錄音 + WebRTC 推到 TV）
9. ⏳ AI 推薦下一首
10. ⏳ 包廂分享連結（短網址）

---

## 4. 反駁清單（CCG 提到但「不要做」的）

1. ❌ **加 Redis** — 單機 SQLite 夠用，加 Redis 是 over-engineering
2. ❌ **加 GraphQL** — REST 已足夠，schema 也不複雜
3. ❌ **加 microservices** — 單 process asyncio 是設計初衷
4. ❌ **HLS streaming server** — yt-dlp 直連 CDN 已 work
5. ❌ **付費 / 訂閱模型** — 個人 / 教育用途 only
6. ❌ **多店面 multi-tenant** — README 明確排除
7. ❌ **OAuth / 帳號系統** — 暱稱 + uuid 已夠
8. ❌ **Container orchestration（k8s）** — Docker compose 夠用
9. ❌ **Service Worker / PWA offline** — 即時性服務不適合 offline
10. ❌ **AI lyric translation** — 過度設計，lrclib 已涵蓋
11. ❌ **強制 CSP / SRI** — 個人區網不需要

---

## 5. 三週排程（rough）

### Week 1（本輪聚焦）
- Day 1-2: Wave 1A server playback authority + Wave 1B Singer Mode + 全螢幕 TV
- Day 3: 整合測試 + Oracle 驗證
- Day 4-5: 緩衝 / 修補 bug

### Week 2
- Atmosphere combo + 隊列動畫 + 過場細節打磨
- Demucs rehydration + yt-dlp 錯誤分類
- 多人 presence

### Week 3
- 結束畫面（假評分）+ 投票踢歌 + 排行榜
- 真實派對 QA + 用戶反饋迭代

---

## 6. 量化成功指標

- TV 一閃退 → 重啟後**自動續播下一首**（目前：卡死）
- 唱歌的人手機自動進入 Singer Mode（目前：跟其他人一樣）
- 歌與歌間隔 < 5 秒，且**有過場動畫**（目前：直接黑屏切歌）
- HTTPS 隧道下 WS **不再斷線**（目前：mixed-content 拒絕）
- 全螢幕影片佔 100% TV 寬度（目前：9/12 = 75%）

---

## 7. 開放問題（你需要拍板）

1. **公網部署？** — 影響是否做 cloudflared tunnel 配置教學
2. **Demucs 是否預設啟用？** — 影響 README 安裝指引
3. **i18n 要不要這版做？** — 影響字串抽取工作量
4. **過場動畫要多澎湃？** — 5 秒是平衡點，要更短 / 更長 / 有跳過按鈕？
5. **Server playback authority 要多嚴格？** — TV ended 是 hint 還是 source-of-truth？

> 除非你回答否則我用：① 暫不部署公網 ② Demucs 預設啟用但安裝可選 ③ 這版不做 i18n ④ 5 秒固定 + 可按任意鍵跳過 ⑤ Server 排程為主，TV ended 為 fast-path hint。

---

## 8. 本輪 Wave 1 範圍鎖定

**Wave 1A — Server-side playback authority**（後端 + 最小 TV/Phone 改動）
- DB schema: 加 `started_at REAL` 到 `queue_items`（status='playing' 那筆設值）
- 新事件：`playback.scheduled` 廣播 next-advance 時間
- Lifespan 啟動 scheduler task：每 5s 掃描已逾時的 playing 項目 → advance
- TV `video.ended` 改為 send `playback.endHint`（伺服器收到立刻 advance）
- `playback.advanced` 廣播包含 `next_starts_at` (server time)

**Wave 1B — Singer Mode + 全螢幕 TV + 5s 過場**（前端）
- Phone: 新元件 `<SingerMode>` 偵測 `getIdentity()?.user_id === playing?.user_id`
  - 顯示在 header banner（霓虹效果）
  - 增加歌詞 nudge 按鈕（±0.3s / ±1s）
  - 增加 vocal mode toggle（即時切原唱/伴奏）
  - 觸覺回饋：`navigator.vibrate([200])` on song start
- TV: 新版 layout
  - 移除 col-span-3 sidebar
  - 影片 100% 寬高 fill
  - QR 縮到右下角小圓（hover 放大）
  - 隊列改用 `Cmd+K` / `Q` 鍵叫出側拉 panel
  - `playback.advanced` 觸發 5 秒過場：
    - 0-2s: 上一首結束畫面（"感謝 Alice 演唱！"）
    - 2-4s: 下一首預告卡（封面 + 標題 + 演唱者 + 倒數）
    - 4-5s: fade in 新影片

---

## 9. 結語

Phase A（穩定 + 設計系統）已完成且 Oracle 驗證。
Phase B 本輪做 Wave 1A + 1B，剩餘必做 + 加分項為下一個 session 的素材。

**動工。**
