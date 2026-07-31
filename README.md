# LINE 報價機器人

在 LINE 聊天室輸入「報價」後,機器人會依序詢問:

1. 商品圖片
2. 品牌
3. 商品名稱
4. 售價(原幣)
5. 匯率
6. 重量(kg)
7. 利潤(固定金額)

全部輸入完成後,自動計算:

```
報價 = 售價/匯率 + (固定運費 + 關稅) x 重量 + 利潤
```

並把結果連同商品圖片(嵌入 `=IMAGE()` 公式)寫入 Google 試算表,同時把報價明細回覆到 LINE 聊天室。

隨時輸入「取消」可中止當次流程。

---

## 事前準備

### 1. LINE Messaging API

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立 Provider 與 Messaging API Channel
2. 在 Channel 設定頁取得 **Channel access token** 與 **Channel secret**,填入 `.env`
3. 先不要急著填 Webhook URL,等專案部署上線、拿到公開 HTTPS 網址後再回來填 `https://你的網域/webhook`,並開啟「Use webhook」

### 2. Google Sheets + Drive API(服務帳戶)

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案
2. 啟用 **Google Sheets API** 和 **Google Drive API**
3. 建立「服務帳戶」(Service Account),下載金鑰 JSON 檔,存成 `service-account.json` 放在專案根目錄
4. 打開你要用的 Google 試算表,把服務帳戶的 email(格式類似 `xxx@xxx.iam.gserviceaccount.com`)加入「共用」,給編輯權限
5. 如果要指定圖片上傳的 Drive 資料夾,也要把該資料夾共用給服務帳戶,並把資料夾 ID 填進 `.env` 的 `DRIVE_FOLDER_ID`
6. 在試算表建立分頁(預設名稱 `報價紀錄`),第一列可先建好表頭方便閱讀:

   ```
   時間 | 品牌 | 名稱 | 圖片 | 售價 | 匯率 | 重量 | 固定運費 | 關稅 | 利潤 | 報價
   ```

### 3. 安裝與啟動

```bash
npm install
cp .env.example .env   # 填入上面取得的各項金鑰與 ID
npm start
```

### 4. 讓 LINE 能連到你的伺服器

本機測試可以用 [ngrok](https://ngrok.com/) 之類的工具把 `localhost:3000` 轉成公開 HTTPS 網址;正式上線建議部署到 Render、Railway、Google Cloud Run 等平台。

---

## 你可能會想調整的地方

- **利潤是固定金額還是百分比?**
  目前程式碼是把「利潤」當成固定金額直接加總。如果你的利潤其實是「售價的 X%」,把 `index.js` 裡 `calculateQuote()` 的 `profit` 改成 `base * profit` 即可。

- **關稅是每公斤金額還是稅率(%)?**
  目前假設「固定運費」和「關稅」都是每公斤金額,兩者相加後乘上重量。如果關稅其實是稅率(例如 5%、10%),`calculateQuote()` 裡有註解說明怎麼改成 `base * TARIFF_RATE`。

- **多筆商品一起報價?**
  目前設計是一次一件商品跑完整個流程。如果你常常要一次上傳多件商品,可以之後再加一個「這批還有下一件嗎?」的分支。

- **對話狀態儲存**
  目前用記憶體 `Map` 存對話進度,伺服器重啟或有多台機器分流時對話會遺失。如果之後流量變大,建議換成 Redis 或資料庫存 session。

- **想要更漂亮的回覆(例如帶圖片的卡片)?**
  可以把 `reply()` 換成 LINE 的 Flex Message,把商品圖片、品牌、報價都排版進一張卡片,而不是純文字。
