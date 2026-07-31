require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const stream = require('stream');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// ---------- Google 驗證 ----------
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, // service-account.json 路徑
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
  ],
});
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const SHEET_NAME = process.env.SHEET_NAME || '報價紀錄';

// 固定運費(每公斤)與關稅(每公斤),屬於後台設定值,不用每次問使用者
// 如果你的關稅其實是「稅率%」而不是每公斤金額,改法在下方 calculateQuote() 註解處
const SHIPPING_RATE_PER_KG = parseFloat(process.env.SHIPPING_RATE_PER_KG || '0');
const TARIFF_RATE_PER_KG = parseFloat(process.env.TARIFF_RATE_PER_KG || '0');

// ---------- 對話狀態(記憶體版) ----------
// 正式上線建議換成 Redis 或資料庫,不然重啟伺服器 / 多機器部署時對話會遺失
const sessions = new Map();

const STEPS = ['image', 'brand', 'name', 'price', 'rate', 'weight', 'profit'];

function newSession() {
  return { stepIndex: 0, data: {} };
}

function fieldPrompt(step) {
  const prompts = {
    image: '請傳送商品圖片📷',
    brand: '請輸入商品「品牌」',
    name: '請輸入「商品名稱」',
    price: '請輸入「售價」(原幣金額,純數字)',
    rate: '請輸入「匯率」(例如 0.032)',
    weight: '請輸入商品「重量」(單位:kg)',
    profit: '請輸入「利潤」金額(純數字)',
  };
  return prompts[step];
}

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const userId = event.source.userId;
  const text = event.message.type === 'text' ? event.message.text.trim() : null;

  // 啟動 / 取消指令
  if (text === '報價' || text === '/quote') {
    sessions.set(userId, newSession());
    return reply(event.replyToken, `開始建立新報價\n${fieldPrompt(STEPS[0])}`);
  }
  if (text === '取消') {
    sessions.delete(userId);
    return reply(event.replyToken, '已取消本次報價流程。輸入「報價」可重新開始。');
  }

  const session = sessions.get(userId);
  if (!session) {
    return reply(event.replyToken, '輸入「報價」開始建立新的商品報價。');
  }

  const currentStep = STEPS[session.stepIndex];

  try {
    const value = await extractStepValue(event, currentStep);
    session.data[currentStep] = value;
    session.stepIndex += 1;

    if (session.stepIndex < STEPS.length) {
      return reply(event.replyToken, fieldPrompt(STEPS[session.stepIndex]));
    }

    // 全部欄位收集完成 -> 計算報價 -> 寫入試算表 -> 回覆使用者
    const quote = calculateQuote(session.data);
    await writeToSheet(session.data, quote);
    sessions.delete(userId);
    return reply(event.replyToken, buildQuoteMessage(session.data, quote));
  } catch (err) {
    return reply(event.replyToken, `⚠️ ${err.message}\n${fieldPrompt(currentStep)}`);
  }
}

async function extractStepValue(event, step) {
  if (step === 'image') {
    if (event.message.type !== 'image') {
      throw new Error('請傳送圖片,不是文字喔');
    }
    const messageId = event.message.id;
    const driveUrl = await downloadAndUploadImage(messageId);
    return driveUrl;
  }

  const text = event.message.type === 'text' ? event.message.text.trim() : null;
  if (text === null) throw new Error('請輸入文字內容');

  if (['price', 'rate', 'weight', 'profit'].includes(step)) {
    const num = Number(text);
    if (Number.isNaN(num)) throw new Error('請輸入有效的數字');
    return num;
  }
  return text; // brand, name 直接存文字
}

// 下載 LINE 圖片,上傳到 Google Drive,回傳可供 =IMAGE() 公式使用的網址
async function downloadAndUploadImage(messageId) {
  const contentStream = await client.getMessageContent(messageId);
  const bufferStream = new stream.PassThrough();
  contentStream.pipe(bufferStream);

  const fileMetadata = {
    name: `product-${messageId}.jpg`,
    parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined,
  };

  const file = await drive.files.create({
    resource: fileMetadata,
    media: { mimeType: 'image/jpeg', body: bufferStream },
    fields: 'id',
  });

  const fileId = file.data.id;

  // 設為「知道連結的任何人皆可檢視」,=IMAGE() 公式才能載入圖片
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return `https://drive.google.com/uc?export=view&id=${fileId}`;
}

function calculateQuote(data) {
  const { price, rate, weight, profit } = data;

  const base = price / rate; // 售價 / 匯率
  // 若關稅其實是「稅率%」而非每公斤金額,把下面改成:
  // const shippingAndTariff = SHIPPING_RATE_PER_KG * weight + base * TARIFF_RATE;
  const shippingAndTariff = (SHIPPING_RATE_PER_KG + TARIFF_RATE_PER_KG) * weight;
  const total = base + shippingAndTariff + profit;

  return {
    base: round2(base),
    shippingAndTariff: round2(shippingAndTariff),
    profit: round2(profit),
    total: round2(total),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function writeToSheet(data, quote) {
  const row = [
    new Date().toLocaleString('zh-TW'),
    data.brand,
    data.name,
    `=IMAGE("${data.image}")`,
    data.price,
    data.rate,
    data.weight,
    SHIPPING_RATE_PER_KG,
    TARIFF_RATE_PER_KG,
    quote.profit,
    quote.total,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:K`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

function buildQuoteMessage(data, quote) {
  return [
    '✅ 報價完成',
    `品牌:${data.brand}`,
    `名稱:${data.name}`,
    `售價:${data.price} / 匯率:${data.rate} → 折合約 ${quote.base}`,
    `重量:${data.weight} kg`,
    `運費+關稅:${quote.shippingAndTariff}`,
    `利潤:${quote.profit}`,
    '——————————',
    `💰 建議報價:${quote.total}`,
  ].join('\n');
}

function reply(replyToken, text) {
  return client.replyMessage(replyToken, { type: 'text', text });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
