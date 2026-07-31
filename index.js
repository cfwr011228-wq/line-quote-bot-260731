require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// ---------- Google Apps Script Web App(取代服務帳戶) ----------
// 這個網址是你部署 Apps Script 後拿到的 /exec 網址
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
// 一組你自己設定的密碼,避免別人亂打你的 Apps Script 網址寫入亂資料
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

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
    const imageBase64 = await getLineImageBase64(messageId);
    return imageBase64;
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

// 下載 LINE 圖片,轉成 base64 字串,稍後整包交給 Apps Script 處理儲存
async function getLineImageBase64(messageId) {
  const contentStream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of contentStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('base64');
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

// 把整包資料(含圖片 base64)POST 給 Apps Script,由它寫入試算表並嵌入圖片
async function writeToSheet(data, quote) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: APPS_SCRIPT_SECRET,
      brand: data.brand,
      name: data.name,
      price: data.price,
      rate: data.rate,
      weight: data.weight,
      shippingAndTariff: quote.shippingAndTariff,
      profit: quote.profit,
      total: quote.total,
      imageBase64: data.image,
    }),
  });

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Apps Script 回應格式錯誤,請確認網址與部署設定');
  }

  if (!json.success) {
    throw new Error(json.error || '寫入試算表失敗');
  }
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
