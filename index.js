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
  '韓幣': { code: 'KRW', country: '韓國', emoji: '🇰🇷' },
  '美金': { code: 'USD', country: '美國', emoji: '💵' },
  '日幣': { code: 'JPY', country: '日本', emoji: '💴' },
  '泰銖': { code: 'THB', country: '泰國', emoji: '🇹🇭' },
};

const CATEGORY_EMOJI = {
  '食品類': '🍔',
  '玩具類': '🧸',
  '電器用品': '🔌',
  '藥品類': '💊',
  '服飾類': '👕',
  '美妝類': '💄',
  '文具/雜貨': '✏️',
  '寢具': '🛏️',
  '噴霧類': '💨',
  '保健食品': '🌿',
};
const CATEGORIES = Object.keys(CATEGORY_EMOJI);

function numberParser(text) {
  const n = Number(text);
  if (Number.isNaN(n)) throw new Error('請輸入有效的數字');
  return n;
}

// 四捨五入到十位數(個位數變 0),例如 1234 -> 1230, 1235 -> 1240
function roundTo10(n) {
  return Math.round(n / 10) * 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
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

// ------------------- 整段範本欄位定義 -------------------
// type: 'text' | 'number' | 'price'(number 再四捨五入到十位數)
// required: 沒填會擋下來要求重填;沒有 required 也沒有 default 的欄位,空白視為略過(存 null)

const GENERAL_FIELDS = [
  { label: '商品品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '原價', key: 'originalPrice', type: 'number' },
  { label: '售價', key: 'price', type: 'price', required: true },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '重量(kg)', key: 'weight', type: 'number' }, // 選填,未填代表親自帶回,不加運費
  { label: '匯率', key: 'fxRate', type: 'number' },
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

const PEER_TWD_FIELDS = [
  { label: '同行姓名', key: 'peerName', type: 'text', required: true },
  { label: '商品品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '售價', key: 'price', type: 'price', required: true },
  { label: '重量(kg)', key: 'weight', type: 'number' }, // 選填,未填代表已含運費
  { label: '每公斤運費', key: 'shippingRate', type: 'number', default: 200 },
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

const PEER_KRW_FIELDS = [
  { label: '同行姓名', key: 'peerName', type: 'text', required: true },
  { label: '商品品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '售價', key: 'price', type: 'price', required: true },
  { label: '買手費(%)', key: 'buyerFeePercent', type: 'number', required: true },
  { label: '重量(kg)', key: 'weight', type: 'number', required: true },
  { label: '每公斤運費', key: 'shippingRate', type: 'number', default: 200 },
  { label: '同行匯率', key: 'peerRate', type: 'number', default: 42 },
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

const KOREA_KRW_FIELDS = [
  { label: '購買地點', key: 'location', type: 'text' }, // 選填,不填則帶入品牌
  { label: '品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '備註', key: 'note', type: 'text' },
  { label: '原價', key: 'originalPrice', type: 'number' },
  { label: '售價', key: 'price', type: 'number', required: true }, // 不做四捨五入,直接照打的存
  { label: '重量(kg)', key: 'weight', type: 'number' }, // 選填,未填代表親飛帶回,不加運費
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

const KOREA_KRW_TEMPLATE_PROMPT = buildTemplateText(
  '請複製整段填寫、回傳\n⚠️購買地點:選填,不填則帶入品牌\n⚠️顏色/尺寸/款式/備註/原價:選填\n⚠️重量:選填,未填則為親飛帶回(不加運費)\n⚠️匯率已自動帶入,不用填',
  KOREA_KRW_FIELDS
);

function buildTemplateText(instruction, fields) {
  const lines = fields.map((f) => `${f.label}：${f.default !== undefined ? f.default : ''}`);
  return `${instruction}\n\n${lines.join('\n')}`;
}

function buildGeneralTemplatePrompt(session) {
  const fieldsWithDynamicDefault = GENERAL_FIELDS.map((f) =>
    f.key === 'fxRate' ? { ...f, default: session.data.fxRate } : f
  );
  return buildTemplateText(
    '請複製整段填寫、回傳\n⚠️原價/顏色/尺寸/款式:選填\n⚠️重量:選填,未填則為親自帶回(不加運費)\n⚠️匯率已帶入今日參考匯率,如需使用別的匯率請自行修改',
    fieldsWithDynamicDefault
  );
}

const PEER_TWD_TEMPLATE_PROMPT = buildTemplateText(
  '請複製整段填寫、回傳\n⚠️顏色/尺寸/款式:選填\n⚠️重量:選填,未填則為已含運費',
  PEER_TWD_FIELDS
);
const PEER_KRW_TEMPLATE_PROMPT = buildTemplateText(
  '請複製整段填寫、回傳\n⚠️顏色/尺寸/款式:選填',
  PEER_KRW_FIELDS
);

// 解析使用者傳回的整段文字,依照每一行「標籤：值」對應欄位
function parseTemplate(text, fields, dynamicDefaults) {
  dynamicDefaults = dynamicDefaults || {};
  const map = {};
  text.split('\n').forEach((line) => {
    const idx = line.search(/[:：]/);
    if (idx === -1) return;
    const label = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    map[label] = value;
  });

  const data = {};
  const missing = [];

  fields.forEach((f) => {
    const raw = map[f.label] || '';

    if (f.type === 'text') {
      if (!raw) {
        if (f.required) missing.push(f.label);
        data[f.key] = null;
      } else {
        data[f.key] = raw;
      }
      return;
    }

    // number / price
    if (!raw) {
      if (f.default !== undefined) {
        data[f.key] = f.default;
      } else if (dynamicDefaults[f.key] !== undefined) {
        data[f.key] = dynamicDefaults[f.key];
      } else if (f.required) {
        missing.push(f.label);
      } else {
        data[f.key] = null;
      }
      return;
    }

    const m = raw.match(/-?\d+(\.\d+)?/);
    if (!m) {
      missing.push(`${f.label}(請輸入數字)`);
      return;
    }
    let num = Number(m[0]);
    if (f.type === 'price') num = roundTo10(num);
    data[f.key] = num;
  });

  if (missing.length > 0) {
    throw new Error(`還缺少或格式不正確:${missing.join('、')},請重新整段貼上`);
  }
  return data;
}

// ------------------- 流程定義 -------------------

const GENERAL_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  {
    key: 'currency',
    quickReplyItems: Object.entries(CURRENCY_META).map(([name, meta]) => ({
      label: `${meta.emoji} ${name}`,
      text: name,
    })),
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
      return `今日參考匯率:台幣 1:${rate}(${meta.country},僅供參考)`;
    },
  },
  {
    key: 'generalFields',
    type: 'template',
    fields: GENERAL_FIELDS,
    promptFn: buildGeneralTemplatePrompt,
    dynamicDefaultsFn: (session) => ({ fxRate: session.data.fxRate }),
  },
  {
    key: 'category',
    quickReplyItems: CATEGORIES.map((cat) => ({ label: `${CATEGORY_EMOJI[cat]} ${cat}`, text: cat })),
    prompt: '請選擇商品類別',
    parse: (text) => {
      if (!CATEGORIES.includes(text)) throw new Error('請點選下方選單的類別');
      return text;
    },
  },
];

const PEER_TWD_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  { key: 'peerTwdFields', type: 'template', fields: PEER_TWD_FIELDS, prompt: PEER_TWD_TEMPLATE_PROMPT },
];

const PEER_KRW_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  { key: 'peerKrwFields', type: 'template', fields: PEER_KRW_FIELDS, prompt: PEER_KRW_TEMPLATE_PROMPT },
];

const KOREA_KRW_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  { key: 'koreaKrwFields', type: 'template', fields: KOREA_KRW_FIELDS, prompt: KOREA_KRW_TEMPLATE_PROMPT },
  {
    key: 'category',
    quickReplyItems: CATEGORIES.map((cat) => ({ label: `${CATEGORY_EMOJI[cat]} ${cat}`, text: cat })),
    prompt: '請選擇商品類別',
    parse: (text) => {
      if (!CATEGORIES.includes(text)) throw new Error('請點選下方選單的類別');
      return text;
    },
  },
];

const FLOWS = {
  general: GENERAL_STEPS,
  peerTwd: PEER_TWD_STEPS,
  peerKrw: PEER_KRW_STEPS,
  koreaKrw: KOREA_KRW_STEPS,
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

function stepPrompt(step, session) {
  return step.promptFn ? step.promptFn(session) : step.prompt;
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
    return client.replyMessage(event.replyToken, buildStepMessage(stepPrompt(step, session), step));
  }

  if (text === '同行報價') {
    sessions.set(userId, { flow: 'peerSelect', stepIndex: 0, data: {} });
    return client.replyMessage(
      event.replyToken,
      buildStepMessage('請選擇報價類型', {
        quickReplyItems: [
          { label: '🇹🇼 台幣報價', text: '台幣報價' },
          { label: '🇰🇷 韓幣報價', text: '韓幣報價' },
        ],
      })
    );
  }

  if (text === '韓國代購' && !sessions.has(userId)) {
    const session = newSession('koreaKrw');
    sessions.set(userId, session);
    const meta = CURRENCY_META['韓幣'];
    const liveRate = await fetchFxRate(meta.code);
    const usedRate = round2(liveRate - 2);
    session.data.fxRate = usedRate;
    const infoMsg = `今日參考匯率:台幣 1:${liveRate}(韓國)\n本次報價使用匯率:1:${usedRate}(即時匯率−2)`;
    const step = advance(KOREA_KRW_STEPS, session);
    return client.replyMessage(event.replyToken, [buildStepMessage(infoMsg), buildStepMessage(stepPrompt(step, session), step)]);
  }

  if (text === '改報價' || text === '改利潤') {
    sessions.set(userId, { flow: 'override', field: text === '改報價' ? 'quote' : 'profit', stepIndex: 0, data: {} });
    return client.replyMessage(event.replyToken, buildStepMessage('請輸入要修改的商品編號'));
  }

  const session = sessions.get(userId);
  if (!session) {
    return client.replyMessage(event.replyToken, buildStepMessage('輸入「一般報價」「同行報價」或「韓國代購」開始建立報價,或輸入「改報價」「改利潤」修改已建立的商品。'));
  }

  if (session.flow === 'override') {
    if (event.message.type !== 'text') {
      return client.replyMessage(event.replyToken, buildStepMessage('請用文字輸入'));
    }
    const label = session.field === 'quote' ? '報價' : '利潤';

    if (!session.data.productId) {
      session.data.productId = text.trim();
      return client.replyMessage(event.replyToken, buildStepMessage(`請輸入新的${label}金額`));
    }

    let value;
    try {
      value = numberParser(text);
    } catch (err) {
      return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}\n請輸入數字`));
    }

    const productId = session.data.productId;
    sessions.delete(userId);
    try {
      const result = await submitOverride(session.field, productId, value);
      const lines = [`✅ 已更新 編號 ${productId} 的${label}`, `新${label}:${value}`];
      if (result.newTotal !== undefined) lines.push(`目前報價:${result.newTotal}`);
      return client.replyMessage(event.replyToken, buildStepMessage(lines.join('\n')));
    } catch (err) {
      return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}`));
    }
  }

  if (session.flow === 'peerSelect') {
    if (text === '台幣報價' || text === '韓幣報價') {
      session.flow = text === '台幣報價' ? 'peerTwd' : 'peerKrw';
      session.stepIndex = 0;
      const step = advance(FLOWS[session.flow], session);
      return client.replyMessage(event.replyToken, buildStepMessage(stepPrompt(step, session), step));
    }
    return client.replyMessage(
      event.replyToken,
      buildStepMessage('請點選下方選單:台幣報價 或 韓幣報價', {
        quickReplyItems: [
          { label: '🇹🇼 台幣報價', text: '台幣報價' },
          { label: '🇰🇷 韓幣報價', text: '韓幣報價' },
        ],
      })
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
    if (currentStep.type === 'image') {
      session.data[currentStep.key] = await getLineImageBase64(event.message.id);
    } else if (currentStep.type === 'template') {
      const dynDefaults = currentStep.dynamicDefaultsFn ? currentStep.dynamicDefaultsFn(session) : {};
      const parsed = parseTemplate(text, currentStep.fields, dynDefaults);
      Object.assign(session.data, parsed);
      // 同行報價-台幣:重量沒填就視為已含運費,每公斤運費強制歸零
      if (session.flow === 'peerTwd' && (session.data.weight === null || session.data.weight === undefined)) {
        session.data.shippingRate = 0;
      }
      if (session.flow === 'koreaKrw' && !session.data.location) {
        session.data.location = session.data.brand;
      }
    } else {
      session.data[currentStep.key] = currentStep.parse(text);
    }

    const extraMessages = [];
    if (currentStep.after) {
      const extra = await currentStep.after(session);
      if (extra) extraMessages.push(extra);
    }

    session.stepIndex += 1;
    const nextStep = advance(steps, session);

    if (nextStep) {
      const messages = [...extraMessages.map((t) => buildStepMessage(t)), buildStepMessage(stepPrompt(nextStep, session), nextStep)];
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
    return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}\n\n${stepPrompt(currentStep, session)}`, currentStep));
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
  return json; // { success, productId, total, shippingRatePerKg?, baseCost, shippingCost }
}

async function submitOverride(field, productId, value) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action: 'override', field, productId, value }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Apps Script 回應格式錯誤,請確認網址與部署設定');
  }
  if (!json.success) {
    throw new Error(json.error || '更新失敗');
  }
  return json; // { success, productId, newTotal }
}

function costLine(result) {
  const sum = result.baseCost + result.shippingCost;
  return `💰 商品成本：${result.baseCost}+${result.shippingCost}=${sum}`;
}

function buildQuoteMessage(flow, data, result) {
  if (flow === 'koreaKrw') {
    const lines = ['✅ 韓幣報價完成', `編號:${result.productId}`, `購買地點:${data.location}`, `品牌:${data.brand}`, `名稱:${data.name}`];
    if (data.color) lines.push(`顏色:${data.color}`);
    if (data.size) lines.push(`尺寸:${data.size}`);
    if (data.style) lines.push(`款式:${data.style}`);
    if (data.note) lines.push(`備註:${data.note}`);
    if (data.originalPrice !== null && data.originalPrice !== undefined) {
      lines.push(`原價:${data.originalPrice}`);
      if (result.originalQuote !== null && result.originalQuote !== undefined) {
        lines.push(`原價報價(參考):${result.originalQuote}`);
      }
    }
    lines.push(`售價:${data.price}(匯率 1:${data.fxRate})`);
    if (data.weight !== null && data.weight !== undefined) {
      lines.push(`重量:${data.weight} kg`);
    } else {
      lines.push('重量:未填(親飛帶回)');
    }
    lines.push(`類別:${data.category}(每公斤運費 ${result.shippingRatePerKg})`);
    lines.push(`利潤:${data.profit}`);
    lines.push('——————————');
    lines.push(`💰 建議報價:${result.total}`);
    lines.push(`💰 商品總成本：${result.baseCost}+${result.shippingCost}=${result.baseCost + result.shippingCost}`);
    return lines.join('\n');
  }

  if (flow === 'general') {
    const lines = ['✅ 報價完成', `編號:${result.productId}`, `品牌:${data.brand}`, `名稱:${data.name}`];
    if (data.originalPrice !== null && data.originalPrice !== undefined) {
      lines.push(`原價:${data.originalPrice}`);
    }
    lines.push(`售價:${data.price}(匯率 1:${data.fxRate})`);
    if (data.weight !== null && data.weight !== undefined) {
      lines.push(`重量:${data.weight} kg`);
    } else {
      lines.push('重量:未填(親自帶回)');
    }
    lines.push(`類別:${data.category}(每公斤運費 ${result.shippingRatePerKg})`);
    lines.push(`利潤:${data.profit}`);
    lines.push('——————————');
    lines.push(`💰 建議報價:${result.total}`);
    lines.push(costLine(result));
    return lines.join('\n');
  }

  if (flow === 'peerTwd') {
    const lines = ['✅ 同行報價完成(台幣)', `編號:${result.productId}`, `同行:${data.peerName}`, `品牌:${data.brand}`, `名稱:${data.name}`];
    if (data.color) lines.push(`顏色:${data.color}`);
    if (data.size) lines.push(`尺寸:${data.size}`);
    if (data.style) lines.push(`款式:${data.style}`);
    lines.push(`售價:${data.price}`);
    if (data.weight) {
      lines.push(`重量:${data.weight} kg,每公斤運費:${data.shippingRate}`);
    } else {
      lines.push('重量:未填(售價已含運費)');
    }
    lines.push(`利潤:${data.profit}`);
    lines.push('——————————');
    lines.push(`💰 建議報價:${result.total}`);
    lines.push(costLine(result));
    return lines.join('\n');
  }

  const lines = [
    '✅ 同行報價完成(韓幣)',
    `編號:${result.productId}`,
    `同行:${data.peerName}`,
    `品牌:${data.brand}`,
    `名稱:${data.name}`,
  ];
  if (data.color) lines.push(`顏色:${data.color}`);
  if (data.size) lines.push(`尺寸:${data.size}`);
  if (data.style) lines.push(`款式:${data.style}`);
  lines.push(`售價:${data.price}(同行匯率 1:${data.peerRate})`);
  lines.push(`買手費:${data.buyerFeePercent}%`);
  lines.push(`重量:${data.weight} kg,每公斤運費:${data.shippingRate}`);
  lines.push(`利潤:${data.profit}`);
  lines.push('——————————');
  lines.push(`💰 建議報價:${result.total}`);
  lines.push(costLine(result));
  return lines.join('\n');
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
