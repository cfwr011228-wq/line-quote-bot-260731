require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

// ---------- 對話狀態(記憶體版,重啟會遺失,正式上線建議換 Redis/DB) ----------
const sessions = new Map();

const CURRENCY_META = {
  '韓幣': { code: 'KRW', country: '韓國' },
  '美金': { code: 'USD', country: '美國' },
  '日幣': { code: 'JPY', country: '日本' },
  '泰銖': { code: 'THB', country: '泰國' },
};

const CATEGORIES = [
  '食品類', '玩具類', '電器用品', '藥品類', '服飾類',
  '美妝類', '文具/雜貨', '寢具', '噴霧類', '保健食品',
];

function numberParser(text) {
  const n = Number(text);
  if (Number.isNaN(n)) throw new Error('請輸入有效的數字');
  return n;
}

// 售價要四捨五入到十位數(個位數變 0),例如 1234 -> 1230, 1235 -> 1240
function roundTo10(n) {
  return Math.round(n / 10) * 10;
}

function priceParser(text) {
  return roundTo10(numberParser(text));
}

// items: 陣列,每個可以是字串(label=text)或 {label, text}
function quickReplyOf(items) {
  return {
    items: items.map((it) => {
      const label = typeof it === 'string' ? it : it.label;
      const text = typeof it === 'string' ? it : it.text;
      return { type: 'action', action: { type: 'message', label, text } };
    }),
  };
}

// 下載 LINE 圖片,轉成 base64 字串,稍後整包交給 Apps Script 存到 Drive
async function getLineImageBase64(messageId) {
  const contentStream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of contentStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('base64');
}

// 免費、不用金鑰的匯率 API,回傳「1 台幣 = X 外幣」
async function fetchFxRate(code) {
  const res = await fetch('https://open.er-api.com/v6/latest/TWD');
  const json = await res.json();
  if (json.result !== 'success' || !json.rates || !json.rates[code]) {
    throw new Error('匯率查詢失敗,請稍後再試一次');
  }
  const raw = json.rates[code];
  return raw >= 10 ? Math.round(raw) : Math.round(raw * 100) / 100;
}

// ------------------- 流程定義 -------------------

const GENERAL_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  {
    key: 'currency',
    quickReplyItems: Object.keys(CURRENCY_META),
    prompt: '請選擇幣別',
    parse: (text) => {
      if (!CURRENCY_META[text]) throw new Error('請點選下方選單的幣別');
      return text;
    },
    // 選完幣別後,額外查詢並回覆今日匯率
    after: async (session) => {
      const meta = CURRENCY_META[session.data.currency];
      const rate = await fetchFxRate(meta.code);
      session.data.fxRate = rate;
      return `今日台幣:${meta.country} = 1:${rate}`;
    },
  },
  { key: 'brand', prompt: '請輸入商品品牌', parse: (t) => t },
  { key: 'name', prompt: '請輸入商品名稱', parse: (t) => t },
  {
    key: 'originalPrice',
    prompt: '請輸入原價(不需要請按「跳過」)',
    quickReplyItems: ['跳過'],
    parse: (text) => (text === '跳過' ? null : numberParser(text)),
  },
  { key: 'price', prompt: '請輸入售價(原幣金額)', parse: priceParser },
  { key: 'weight', prompt: '請輸入重量(kg)', parse: numberParser },
  {
    key: 'profit',
    prompt: '請輸入利潤(預設200,可直接點下方按鈕)',
    quickReplyItems: [{ label: '使用預設200', text: '200' }],
    parse: numberParser,
  },
  {
    key: 'category',
    quickReplyItems: CATEGORIES,
    prompt: '請選擇商品類別',
    parse: (text) => {
      if (!CATEGORIES.includes(text)) throw new Error('請點選下方選單的類別');
      return text;
    },
  },
];

const PEER_TWD_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  { key: 'peerName', prompt: '請輸入同行姓名', parse: (t) => t },
  { key: 'brand', prompt: '請輸入商品品牌', parse: (t) => t },
  { key: 'name', prompt: '請輸入商品名稱', parse: (t) => t },
  { key: 'price', prompt: '請輸入售價', parse: priceParser },
  {
    key: 'weight',
    prompt: '請輸入重量(kg)(售價已含運費請按「不填」)',
    quickReplyItems: [{ label: '不填(已含運費)', text: '不填' }],
    parse: (text) => (text === '不填' ? null : numberParser(text)),
  },
  {
    key: 'shippingRate',
    prompt: '請輸入每公斤運費(預設200,可直接點下方按鈕)',
    quickReplyItems: [{ label: '使用預設200', text: '200' }],
    parse: numberParser,
    condition: (data) => data.weight !== null && data.weight !== undefined,
    defaultValue: 0,
  },
  {
    key: 'profit',
    prompt: '請輸入利潤(預設200,可直接點下方按鈕)',
    quickReplyItems: [{ label: '使用預設200', text: '200' }],
    parse: numberParser,
  },
];

const PEER_KRW_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  { key: 'peerName', prompt: '請輸入同行姓名', parse: (t) => t },
  { key: 'brand', prompt: '請輸入商品品牌', parse: (t) => t },
  { key: 'name', prompt: '請輸入商品名稱', parse: (t) => t },
  { key: 'price', prompt: '請輸入售價', parse: priceParser },
  { key: 'buyerFeePercent', prompt: '請輸入買手費(輸入百分比數字,例如 5 代表 5%)', parse: numberParser },
  { key: 'weight', prompt: '請輸入重量(kg)', parse: numberParser },
  {
    key: 'shippingRate',
    prompt: '請輸入每公斤運費(預設200,可直接點下方按鈕)',
    quickReplyItems: [{ label: '使用預設200', text: '200' }],
    parse: numberParser,
  },
  {
    key: 'peerRate',
    prompt: '請輸入同行匯率(預設42,可直接點下方按鈕)',
    quickReplyItems: [{ label: '使用預設42', text: '42' }],
    parse: numberParser,
  },
  {
    key: 'profit',
    prompt: '請輸入利潤(預設200,可直接點下方按鈕)',
    quickReplyItems: [{ label: '使用預設200', text: '200' }],
    parse: numberParser,
  },
];

const FLOWS = {
  general: GENERAL_STEPS,
  peerTwd: PEER_TWD_STEPS,
  peerKrw: PEER_KRW_STEPS,
};

// ------------------- LINE webhook -------------------

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

function newSession(flow) {
  return { flow, stepIndex: 0, data: {} };
}

function buildStepMessage(text, step) {
  const msg = { type: 'text', text };
  if (step && step.quickReplyItems) {
    msg.quickReply = quickReplyOf(step.quickReplyItems);
  }
  return msg;
}

// 自動跳過 condition 為 false 的欄位(帶入預設值),回傳下一個要顯示的步驟(或 null 代表流程結束)
function advance(steps, session) {
  while (session.stepIndex < steps.length) {
    const step = steps[session.stepIndex];
    if (step.condition && !step.condition(session.data)) {
      session.data[step.key] = step.defaultValue !== undefined ? step.defaultValue : null;
      session.stepIndex += 1;
      continue;
    }
    return step;
  }
  return null;
}

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const userId = event.source.userId;
  const text = event.message.type === 'text' ? event.message.text.trim() : null;

  if (text === '取消') {
    sessions.delete(userId);
    return client.replyMessage(event.replyToken, buildStepMessage('已取消本次流程。輸入「一般報價」或「同行報價」可重新開始。'));
  }

  if (text === '一般報價') {
    const session = newSession('general');
    sessions.set(userId, session);
    const step = advance(GENERAL_STEPS, session);
    return client.replyMessage(event.replyToken, buildStepMessage(step.prompt, step));
  }

  if (text === '同行報價') {
    sessions.set(userId, { flow: 'peerSelect', stepIndex: 0, data: {} });
    return client.replyMessage(
      event.replyToken,
      buildStepMessage('請選擇報價類型', { quickReplyItems: ['台幣報價', '韓幣報價'] })
    );
  }

  const session = sessions.get(userId);
  if (!session) {
    return client.replyMessage(event.replyToken, buildStepMessage('輸入「一般報價」或「同行報價」開始建立報價。'));
  }

  if (session.flow === 'peerSelect') {
    if (text === '台幣報價' || text === '韓幣報價') {
      session.flow = text === '台幣報價' ? 'peerTwd' : 'peerKrw';
      session.stepIndex = 0;
      const step = advance(FLOWS[session.flow], session);
      return client.replyMessage(event.replyToken, buildStepMessage(step.prompt, step));
    }
    return client.replyMessage(
      event.replyToken,
      buildStepMessage('請點選下方選單:台幣報價 或 韓幣報價', { quickReplyItems: ['台幣報價', '韓幣報價'] })
    );
  }

  const steps = FLOWS[session.flow];
  const currentStep = steps[session.stepIndex];

  if (currentStep.type === 'image') {
    if (event.message.type !== 'image') {
      return client.replyMessage(event.replyToken, buildStepMessage('請傳送圖片,不是文字喔📷', currentStep));
    }
  } else if (event.message.type !== 'text') {
    return client.replyMessage(event.replyToken, buildStepMessage('請用文字輸入,或點選下方選單', currentStep));
  }

  try {
    const value = currentStep.type === 'image'
      ? await getLineImageBase64(event.message.id)
      : currentStep.parse(text);
    session.data[currentStep.key] = value;

    const extraMessages = [];
    if (currentStep.after) {
      const extra = await currentStep.after(session);
      if (extra) extraMessages.push(extra);
    }

    session.stepIndex += 1;
    const nextStep = advance(steps, session);

    if (nextStep) {
      const messages = [...extraMessages.map((t) => buildStepMessage(t)), buildStepMessage(nextStep.prompt, nextStep)];
      return client.replyMessage(event.replyToken, messages);
    }

    // 全部欄位收集完成,呼叫 Apps Script 計算並寫入試算表
    const result = await submitToAppsScript(session.flow, session.data);
    const finalData = session.data;
    const finalFlow = session.flow;
    sessions.delete(userId);
    const messages = [...extraMessages.map((t) => buildStepMessage(t)), buildStepMessage(buildQuoteMessage(finalFlow, finalData, result))];
    return client.replyMessage(event.replyToken, messages);
  } catch (err) {
    return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}\n${currentStep.prompt}`, currentStep));
  }
}

async function submitToAppsScript(flow, data) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, recordType: flow, ...data }),
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
  return json; // { success: true, total, shippingRatePerKg? }
}

function buildQuoteMessage(flow, data, result) {
  if (flow === 'general') {
    const lines = ['✅ 報價完成', `品牌:${data.brand}`, `名稱:${data.name}`];
    if (data.originalPrice !== null && data.originalPrice !== undefined) {
      lines.push(`原價:${data.originalPrice}`);
    }
    lines.push(`售價:${data.price}(匯率 1:${data.fxRate})`);
    lines.push(`重量:${data.weight} kg`);
    lines.push(`類別:${data.category}(每公斤運費 ${result.shippingRatePerKg})`);
    lines.push(`利潤:${data.profit}`);
    lines.push('——————————');
    lines.push(`💰 建議報價:${result.total}`);
    return lines.join('\n');
  }

  if (flow === 'peerTwd') {
    const lines = ['✅ 同行報價完成(台幣)', `同行:${data.peerName}`, `品牌:${data.brand}`, `名稱:${data.name}`, `售價:${data.price}`];
    if (data.weight) {
      lines.push(`重量:${data.weight} kg,每公斤運費:${data.shippingRate}`);
    } else {
      lines.push('重量:未填(售價已含運費)');
    }
    lines.push(`利潤:${data.profit}`);
    lines.push('——————————');
    lines.push(`💰 建議報價:${result.total}`);
    return lines.join('\n');
  }

  const lines = [
    '✅ 同行報價完成(韓幣)',
    `同行:${data.peerName}`,
    `品牌:${data.brand}`,
    `名稱:${data.name}`,
    `售價:${data.price}(同行匯率 1:${data.peerRate})`,
    `買手費:${data.buyerFeePercent}%`,
    `重量:${data.weight} kg,每公斤運費:${data.shippingRate}`,
    `利潤:${data.profit}`,
    '——————————',
    `💰 建議報價:${result.total}`,
  ];
  return lines.join('\n');
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
