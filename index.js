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

function ceilTo10(n) {
  return Math.ceil(n / 10) * 10;
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

// 下載 LINE 圖片,轉成 base64 字串
async function getLineImageBase64(messageId) {
  const contentStream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of contentStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('base64');
}

// 一收到圖片就馬上呼叫 Apps Script 上傳到 Drive,不用等到整個流程最後一步才傳,
// 這樣使用者填表單、選類別的這段時間圖片已經在背景傳完了,最後回覆速度會快很多。
// 如果上傳失敗(例如網路不穩),就退回舊做法,把 base64 一起帶到最後一步再讓 Apps Script 處理。
async function uploadImageToDrive(base64) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action: 'uploadImage', imageBase64: base64 }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '圖片上傳失敗');
  return json.imageUrl;
}

// 免費、不用金鑰的匯率 API,回傳「1 台幣 = X 外幣」
async function fetchFxRate(code) {
  const res = await fetch('https://open.er-api.com/v6/latest/TWD');
  const json = await res.json();
  if (json.result !== 'success' || !json.rates || !json.rates[code]) {
    throw new Error('匯率查詢失敗，請稍後再試一次');
  }
  const raw = json.rates[code];
  return raw >= 10 ? Math.round(raw) : Math.round(raw * 100) / 100;
}

// 美金/免稅店方向相反,要換算成「1 美金 = X 台幣」
async function fetchUsdToTwdRate() {
  const res = await fetch('https://open.er-api.com/v6/latest/TWD');
  const json = await res.json();
  if (json.result !== 'success' || !json.rates || !json.rates.USD) {
    throw new Error('匯率查詢失敗，請稍後再試一次');
  }
  return round2(1 / json.rates.USD);
}

// 韓國運費(韓幣)沒有即時查詢的API,改成向 Apps Script 查上次使用的數字當預設值
async function fetchLastKoreaShippingFee() {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action: 'getLastKoreaShippingFee' }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return 5300; // 查詢失敗就用一個保底預設值,不阻擋流程
  }
  if (!json.success) return 5300;
  return json.value;
}

async function fetchCustomerToken(customerName) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action: 'getCustomerToken', customerName }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Apps Script 回應格式錯誤，請確認網址與部署設定');
  }
  if (!json.success) {
    throw new Error(json.error || '產生連結失敗');
  }
  return json.token;
}

// ------------------- 整段範本欄位定義 -------------------
// type: 'text' | 'number' | 'price'(number 再四捨五入到十位數)
// required: 沒填會擋下來要求重填;沒有 required 也沒有 default 的欄位,空白視為略過(存 null)

const PEER_TWD_FIELDS = [
  { label: '同行姓名', key: 'peerName', type: 'text', required: true },
  { label: '商品品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '連結', key: 'link', type: 'text' },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '備註', key: 'note', type: 'text' },
  { label: '原價', key: 'originalPrice', type: 'number' },
  { label: '售價', key: 'price', type: 'price', required: true },
  { label: '重量（kg）', key: 'weight', type: 'number' }, // 選填,未填代表已含運費
  { label: '每公斤運費', key: 'shippingRate', type: 'number', default: 200 },
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

const PEER_KRW_FIELDS = [
  { label: '同行姓名', key: 'peerName', type: 'text', required: true },
  { label: '商品品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '連結', key: 'link', type: 'text' },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '備註', key: 'note', type: 'text' },
  { label: '原價', key: 'originalPrice', type: 'number' },
  { label: '售價', key: 'price', type: 'price', required: true },
  { label: '買手費（%）', key: 'buyerFeePercent', type: 'number', required: true },
  { label: '重量（kg）', key: 'weight', type: 'number', required: true },
  { label: '每公斤運費', key: 'shippingRate', type: 'number', default: 200 },
  { label: '同行匯率', key: 'peerRate', type: 'number', default: 42 },
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

const PEER_JPY_FIELDS = [
  { label: '同行姓名', key: 'peerName', type: 'text', required: true },
  { label: '商品品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '連結', key: 'link', type: 'text' },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '備註', key: 'note', type: 'text' },
  { label: '原價', key: 'originalPrice', type: 'number' },
  { label: '售價', key: 'price', type: 'price', required: true },
  { label: '買手費（%）', key: 'buyerFeePercent', type: 'number' }, // 選填,未填代表不加成
  { label: '重量（kg）', key: 'weight', type: 'number' }, // 選填,未填代表親飛帶回,不加運費
  { label: '每公斤運費', key: 'shippingRate', type: 'number', default: 200 },
  { label: '同行匯率', key: 'peerRate', type: 'number', default: 0.21 }, // 1日幣=X台幣方向,跟韓幣相反
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

const DUTY_FREE_STORES = { lotte: '樂天', shinsegae: '新世界', emart: '愛寶客', shilla: '新羅', hyundai: '現代' };

// 每間店各自一組「售價」+「連結」欄位,連結選填,填了的話那間店的售價會變成可以點的連結
function buildDutyFreeStoreFields() {
  const fields = [];
  Object.keys(DUTY_FREE_STORES).forEach((key) => {
    fields.push({ label: `${DUTY_FREE_STORES[key]}售價`, key, type: 'number' });
    fields.push({ label: `${DUTY_FREE_STORES[key]}連結`, key: `${key}Link`, type: 'text' });
  });
  return fields;
}

const DUTY_FREE_ONLINE_FIELDS = [
  { label: '品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '備註', key: 'note', type: 'text' },
  ...buildDutyFreeStoreFields(),
  { label: '重量（kg）', key: 'weight', type: 'number' },
  { label: '匯率', key: 'fxRate', type: 'number' },
  { label: '韓國運費（韓幣）', key: 'koreaShippingFee', type: 'number' }, // 每次帶入上次使用的數字,可直接覆蓋
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

const DUTY_FREE_PHYSICAL_FIELDS = [
  { label: '品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '備註', key: 'note', type: 'text' },
  ...buildDutyFreeStoreFields(),
  { label: '折扣1（金卡%）', key: 'discount1', type: 'number' },
  { label: '折扣2（返點%）', key: 'discount2', type: 'number' },
  { label: '重量（kg）', key: 'weight', type: 'number' },
  { label: '匯率', key: 'fxRate', type: 'number' },
  { label: '韓國運費（韓幣）', key: 'koreaShippingFee', type: 'number' }, // 每次帶入上次使用的數字,可直接覆蓋
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

function buildDutyFreeOnlineTemplatePrompt(session) {
  const fieldsWithDynamicDefault = DUTY_FREE_ONLINE_FIELDS.map((f) => {
    if (f.key === 'fxRate') return { ...f, default: session.data.fxRate };
    if (f.key === 'koreaShippingFee') return { ...f, default: session.data.koreaShippingFee };
    return f;
  });
  return buildTemplateText(
    '請複製整段填寫、回傳\n⚠️顏色／尺寸／款式／備註：選填\n⚠️5間店的售價至少填一間，系統會自動抓最低價計算\n⚠️各店連結：選填，填了那間店的售價就會變成可以點的連結\n⚠️重量：選填，未填則為親飛帶回（不加運費）\n⚠️匯率已帶入本次使用匯率，如需使用別的匯率請直接修改\n⚠️韓國運費已帶入上次使用的數字，如需使用別的金額請直接修改',
    fieldsWithDynamicDefault
  );
}

function buildDutyFreePhysicalTemplatePrompt(session) {
  const fieldsWithDynamicDefault = DUTY_FREE_PHYSICAL_FIELDS.map((f) => {
    if (f.key === 'fxRate') return { ...f, default: session.data.fxRate };
    if (f.key === 'koreaShippingFee') return { ...f, default: session.data.koreaShippingFee };
    return f;
  });
  return buildTemplateText(
    '請複製整段填寫、回傳\n⚠️顏色／尺寸／款式／備註：選填\n⚠️5間店的售價至少填一間，系統會自動抓最低價計算\n⚠️各店連結：選填，填了那間店的售價就會變成可以點的連結\n⚠️折扣1／折扣2：選填（輸入百分比數字，例如5代表95折）\n⚠️重量：選填，未填則為親飛帶回（不加運費）\n⚠️匯率已帶入本次使用匯率，如需使用別的匯率請直接修改\n⚠️韓國運費已帶入上次使用的數字，如需使用別的金額請直接修改',
    fieldsWithDynamicDefault
  );
}

const KOREA_KRW_FIELDS = [
  { label: '購買地點', key: 'location', type: 'text' }, // 選填,不填則帶入品牌
  { label: '品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '連結', key: 'link', type: 'text' },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '備註', key: 'note', type: 'text' },
  { label: '原價', key: 'originalPrice', type: 'number' },
  { label: '售價', key: 'price', type: 'number', required: true }, // 不做四捨五入,直接照打的存
  { label: '重量（kg）', key: 'weight', type: 'number' }, // 選填,未填代表親飛帶回,不加運費
  { label: '匯率', key: 'fxRate', type: 'number' },
  { label: '韓國運費（韓幣）', key: 'koreaShippingFee', type: 'number' }, // 每次帶入上次使用的數字,可直接覆蓋
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

function buildKoreaKrwTemplatePrompt(session) {
  const fieldsWithDynamicDefault = KOREA_KRW_FIELDS.map((f) => {
    if (f.key === 'fxRate') return { ...f, default: session.data.fxRate };
    if (f.key === 'koreaShippingFee') return { ...f, default: session.data.koreaShippingFee };
    return f;
  });
  return buildTemplateText(
    '請複製整段填寫、回傳\n⚠️購買地點：選填，不填則帶入品牌\n⚠️連結／顏色／尺寸／款式／備註／原價：選填\n⚠️重量：選填，未填則為親飛帶回（不加運費）\n⚠️匯率已帶入本次使用匯率，如需使用別的匯率請直接修改\n⚠️韓國運費已帶入上次使用的數字，如需使用別的金額請直接修改',
    fieldsWithDynamicDefault
  );
}

const USA_FIELDS = [
  { label: '購買地點', key: 'location', type: 'text' }, // 選填,不填則帶入品牌
  { label: '品牌', key: 'brand', type: 'text', required: true },
  { label: '商品名稱', key: 'name', type: 'text', required: true },
  { label: '連結', key: 'link', type: 'text' },
  { label: '顏色', key: 'color', type: 'text' },
  { label: '尺寸', key: 'size', type: 'text' },
  { label: '款式', key: 'style', type: 'text' },
  { label: '備註', key: 'note', type: 'text' },
  { label: '原價', key: 'originalPrice', type: 'number' },
  { label: '售價', key: 'price', type: 'number', required: true },
  { label: '重量（kg）', key: 'weight', type: 'number' }, // 選填,未填代表親飛帶回,運費+包材費都不收
  { label: '匯率', key: 'fxRate', type: 'number' },
  { label: '買手費（%）', key: 'buyerFeePercent', type: 'number', default: 10 },
  { label: '運費（每磅）', key: 'shippingFeePerLb', type: 'number', default: 135 },
  { label: '包材費', key: 'packagingFee', type: 'number', default: 30 },
  { label: '利潤', key: 'profit', type: 'number', default: 200 },
];

function buildUsaTemplatePrompt(session) {
  const fieldsWithDynamicDefault = USA_FIELDS.map((f) =>
    f.key === 'fxRate' ? { ...f, default: session.data.fxRate } : f
  );
  return buildTemplateText(
    '請複製整段填寫、回傳\n⚠️購買地點：選填，不填則帶入品牌\n⚠️連結／顏色／尺寸／款式／備註／原價：選填\n⚠️重量：選填，未填則為親飛帶回（運費、包材費都不收）\n⚠️匯率已帶入本次使用匯率，如需使用別的匯率請直接修改\n⚠️運費是「每磅」美金135，重量請照樣輸入公斤，系統會自動換算成磅計費\n⚠️買手費／運費／包材費：可不填，不填就用預設值',
    fieldsWithDynamicDefault
  );
}

function buildTemplateText(instruction, fields) {
  const lines = fields.map((f) => `${f.label}：${f.default !== undefined ? f.default : ''}`);
  return `${instruction}\n\n${lines.join('\n')}`;
}

const PEER_TWD_TEMPLATE_PROMPT = buildTemplateText(
  '請複製整段填寫、回傳\n⚠️連結／顏色／尺寸／款式／備註／原價：選填\n⚠️重量：選填，未填則為已含運費',
  PEER_TWD_FIELDS
);
const PEER_KRW_TEMPLATE_PROMPT = buildTemplateText(
  '請複製整段填寫、回傳\n⚠️連結／顏色／尺寸／款式／備註／原價：選填',
  PEER_KRW_FIELDS
);
const PEER_JPY_TEMPLATE_PROMPT = buildTemplateText(
  '請複製整段填寫、回傳\n⚠️連結／顏色／尺寸／款式／備註／原價：選填',
  PEER_JPY_FIELDS
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
      missing.push(`${f.label}（請輸入數字）`);
      return;
    }
    let num = Number(m[0]);
    if (f.type === 'price') num = roundTo10(num);
    data[f.key] = num;
  });

  if (missing.length > 0) {
    throw new Error(`還缺少或格式不正確：${missing.join('、')}，請重新整段貼上`);
  }
  return data;
}

// 解析單一行,格式:識別碼/數量,或識別碼/數量/顏色/尺寸/款式
// 識別碼可以是:商品編號(對照商品總表)、運費項目名稱(對照運費代碼表,例如「賣貨便免運」)、
// 或關鍵字「折扣」(後面數字直接當金額,可以是負數)。
// 顏色/尺寸/款式可以整段不填,也可以中間留空段(用連續的斜線代表跳過),例如:
//   202608090016/2            -> 只有編號跟數量
//   202608090016/2//XL/       -> 尺寸XL,顏色、款式留空
//   賣貨便免運/1               -> 運費項目
//   折扣/-100                  -> 折扣,直接扣100元
function parseOrderItemLine(line) {
  const parts = line.split(/[\/／]/).map((s) => s.trim());
  if (parts.length < 2) return null;
  const identifier = parts[0];
  if (!identifier) return null;
  if (!/^-?\d+(\.\d+)?$/.test(parts[1])) return null; // 數量/金額允許負數(折扣、扣運費用)

  return {
    identifier,
    quantity: Number(parts[1]),
    color: parts[2] ? parts[2] : null,
    size: parts[3] ? parts[3] : null,
    style: parts[4] ? parts[4] : null,
  };
}

// 解析「新增訂單」整段文字:客人姓名 + 付款方式(選填)為「標籤：值」,
// 商品編號/數量/顏色/尺寸/款式可以填很多行,顏色/尺寸/款式選填,例如 202608090016/2/紅/XL/長版
function parseOrderTemplate(text) {
  let customerName = null;
  let paymentMethod = null;
  const items = [];

  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    const idx = line.search(/[:：]/);
    if (idx !== -1) {
      const label = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (label === '客人姓名') {
        if (value) customerName = value;
        return;
      }
      if (label === '付款方式') {
        if (value) paymentMethod = value;
        return;
      }
      // 「商品編號/數量/顏色/尺寸/款式：」這種標題行,如果值剛好也是商品行格式就一併收下,否則當標題略過
      if (value) {
        const item = parseOrderItemLine(value);
        if (item) items.push(item);
      }
      return;
    }

    // 沒有冒號的行,檢查是不是商品行
    const item = parseOrderItemLine(line);
    if (item) items.push(item);
  });

  const missing = [];
  if (!customerName) missing.push('客人姓名');
  if (items.length === 0) missing.push('商品編號／數量（格式：商品編號／數量，一行一組）');
  if (missing.length > 0) {
    throw new Error(`還缺少或格式不正確：${missing.join('、')}，請重新整段貼上`);
  }

  return { customerName, paymentMethod, items };
}

// ------------------- 流程定義 -------------------


const PEER_TWD_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  { key: 'peerTwdFields', type: 'template', fields: PEER_TWD_FIELDS, prompt: PEER_TWD_TEMPLATE_PROMPT },
];

const PEER_KRW_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  { key: 'peerKrwFields', type: 'template', fields: PEER_KRW_FIELDS, prompt: PEER_KRW_TEMPLATE_PROMPT },
];

const PEER_JPY_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  { key: 'peerJpyFields', type: 'template', fields: PEER_JPY_FIELDS, prompt: PEER_JPY_TEMPLATE_PROMPT },
];

const KOREA_KRW_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  {
    key: 'koreaKrwFields',
    type: 'template',
    fields: KOREA_KRW_FIELDS,
    promptFn: buildKoreaKrwTemplatePrompt,
    dynamicDefaultsFn: (session) => ({ fxRate: session.data.fxRate, koreaShippingFee: session.data.koreaShippingFee }),
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

const USA_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  {
    key: 'usaFields',
    type: 'template',
    fields: USA_FIELDS,
    promptFn: buildUsaTemplatePrompt,
    dynamicDefaultsFn: (session) => ({ fxRate: session.data.fxRate }),
  },
];

const DUTY_FREE_ONLINE_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  {
    key: 'dutyFreeOnlineFields',
    type: 'template',
    fields: DUTY_FREE_ONLINE_FIELDS,
    promptFn: buildDutyFreeOnlineTemplatePrompt,
    dynamicDefaultsFn: (session) => ({ fxRate: session.data.fxRate, koreaShippingFee: session.data.koreaShippingFee }),
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

const DUTY_FREE_PHYSICAL_STEPS = [
  { key: 'imageBase64', type: 'image', prompt: '請傳送商品圖片📷' },
  {
    key: 'dutyFreePhysicalFields',
    type: 'template',
    fields: DUTY_FREE_PHYSICAL_FIELDS,
    promptFn: buildDutyFreePhysicalTemplatePrompt,
    dynamicDefaultsFn: (session) => ({ fxRate: session.data.fxRate, koreaShippingFee: session.data.koreaShippingFee }),
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

const ORDER_TEMPLATE_PROMPT =
  '請複製「客人姓名」以下的部分填寫、回傳\n' +
  '⚠️付款方式：選填\n' +
  '⚠️商品編號請照商品總表上的編號填，系統會自動帶入品牌／名稱／單價\n' +
  '⚠️可以填很多筆，一行一組，格式：識別碼／數量／顏色／尺寸／款式（用斜線分開）\n' +
  '⚠️顏色／尺寸／款式選填，沒有的話該欄留空或整段不寫都可以\n' +
  '⚠️運費也可以列成一行，識別碼直接打運費代碼表上的代碼（例如「賣貨便_免運／1」）\n' +
  '⚠️折扣列成一行，識別碼打「折扣」，數量直接當金額打負數（例如「折扣／-100」）\n' +
  '⚠️韓國境內運費也是列成一行，識別碼打「韓國境內運費」，數量直接當金額打負數（例如「韓國境內運費／-70」）\n' +
  '⚠️客人要用購物金折抵，列成一行，識別碼打「購物金」，數量直接當金額打負數（例如「購物金／-200」），系統會自動檢查餘額夠不夠扣\n\n' +
  '客人姓名：\n' +
  '商品編號／數量／顏色／尺寸／款式：\n' +
  '付款方式：';

const ORDER_STEPS = [
  { key: 'orderFields', type: 'orderItems', prompt: ORDER_TEMPLATE_PROMPT },
  {
    key: 'received',
    quickReplyItems: [
      { label: '✅ 已收款', text: '已收款' },
      { label: '⏳ 未收款', text: '未收款' },
    ],
    prompt: '請問已經收款了嗎?',
    parse: (text) => {
      if (text !== '已收款' && text !== '未收款') throw new Error('請點選下方選單');
      return text === '已收款';
    },
  },
];

const FLOWS = {
  peerTwd: PEER_TWD_STEPS,
  peerKrw: PEER_KRW_STEPS,
  peerJpy: PEER_JPY_STEPS,
  koreaKrw: KOREA_KRW_STEPS,
  usa: USA_STEPS,
  dutyFreeOnline: DUTY_FREE_ONLINE_STEPS,
  dutyFreePhysical: DUTY_FREE_PHYSICAL_STEPS,
  order: ORDER_STEPS,
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

// 依流程判斷要用哪個國旗表情符號
function flagForFlow(flow, data) {
  if (flow === 'koreaKrw' || flow === 'dutyFreeOnline' || flow === 'dutyFreePhysical' || flow === 'peerKrw') return '🇰🇷';
  if (flow === 'peerTwd') return '🇹🇼';
  if (flow === 'peerJpy') return '🇯🇵';
  if (flow === 'usa') return '🇺🇸';
  return '';
}

// 簡短摘要:國旗品牌 / 商品名稱 / 顏色尺寸款式(有才顯示) / $報價,報價完成、改報價、改利潤之後都會附上這個
function buildShortSummary(flag, brand, name, total, color, size, style) {
  const lines = [`${flag}${brand}`, name];
  const details = [];
  if (color) details.push(`顏色｜${color}`);
  if (size) details.push(`尺寸｜${size}`);
  if (style) details.push(`款式｜${style}`);
  if (details.length > 0) {
    lines.push('', ...details);
  }
  lines.push('', `$${total}`);
  return lines.join('\n');
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

// 開始一個流程,把「額外訊息(例如匯率)+第一步(通常是傳圖片)+如果緊接著是範本步驟就一次帶出來」
// 一次回傳,這樣使用者傳圖片、等上傳的空檔就能先準備好範本內容,不用等圖片傳完才看到格式。
function startFlowMessages(steps, session, infoMessages) {
  const firstStep = advance(steps, session);
  const messages = (infoMessages || []).map((t) => buildStepMessage(t));
  messages.push(buildStepMessage(stepPrompt(firstStep, session), firstStep));

  const nextStep = steps[session.stepIndex + 1];
  if (firstStep.type === 'image' && nextStep && nextStep.type === 'template') {
    messages.push(buildStepMessage(stepPrompt(nextStep, session), nextStep));
    session.templatePreShown = true;
  }
  return messages;
}

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const userId = event.source.userId;
  const text = event.message.type === 'text' ? event.message.text.trim() : null;

  if (text === '取消') {
    sessions.delete(userId);
    return client.replyMessage(event.replyToken, buildStepMessage('已取消本次流程。輸入「同行報價」可重新開始。'));
  }

  if (text === '同行報價') {
    sessions.set(userId, { flow: 'peerSelect', stepIndex: 0, data: {} });
    return client.replyMessage(
      event.replyToken,
      buildStepMessage('請選擇報價類型', {
        quickReplyItems: [
          { label: '🇹🇼 台幣報價', text: '台幣報價' },
          { label: '🇰🇷 韓幣報價', text: '韓幣報價' },
          { label: '🇯🇵 日幣報價', text: '日幣報價' },
        ],
      })
    );
  }

  if (text === '韓國代購') {
    const session = newSession('koreaKrw');
    sessions.set(userId, session);
    const meta = CURRENCY_META['韓幣'];
    const liveRate = await fetchFxRate(meta.code);
    const usedRate = round2(liveRate - 4);
    session.data.fxRate = usedRate;
    session.data.koreaShippingFee = await fetchLastKoreaShippingFee();
    const infoMsg = `今日參考匯率：台幣 1：${liveRate}（韓國）\n本次報價使用匯率：1：${usedRate}（即時匯率−4）`;
    return client.replyMessage(event.replyToken, startFlowMessages(KOREA_KRW_STEPS, session, [infoMsg]));
  }

  if (text === '線上免稅店') {
    const session = newSession('dutyFreeOnline');
    sessions.set(userId, session);
    const liveRate = await fetchUsdToTwdRate();
    const usedRate = round2(liveRate + 1);
    session.data.fxRate = usedRate;
    session.data.koreaShippingFee = await fetchLastKoreaShippingFee();
    const infoMsg = `今日參考匯率：1美金：${liveRate}台幣\n本次報價使用匯率：1美金：${usedRate}台幣（即時匯率+1）`;
    return client.replyMessage(event.replyToken, startFlowMessages(DUTY_FREE_ONLINE_STEPS, session, [infoMsg]));
  }

  if (text === '實體免稅店') {
    const session = newSession('dutyFreePhysical');
    sessions.set(userId, session);
    const liveRate = await fetchUsdToTwdRate();
    const usedRate = round2(liveRate + 1);
    session.data.fxRate = usedRate;
    session.data.koreaShippingFee = await fetchLastKoreaShippingFee();
    const infoMsg = `今日參考匯率：1美金：${liveRate}台幣\n本次報價使用匯率：1美金：${usedRate}台幣（即時匯率+1）`;
    return client.replyMessage(event.replyToken, startFlowMessages(DUTY_FREE_PHYSICAL_STEPS, session, [infoMsg]));
  }

  if (text === '美國代購') {
    const session = newSession('usa');
    sessions.set(userId, session);
    const liveRate = await fetchUsdToTwdRate();
    const usedRate = round2(liveRate + 1);
    session.data.fxRate = usedRate;
    const infoMsg = `今日參考匯率：1美金：${liveRate}台幣\n本次報價使用匯率：1美金：${usedRate}台幣（即時匯率+1）`;
    return client.replyMessage(event.replyToken, startFlowMessages(USA_STEPS, session, [infoMsg]));
  }

  if (text === '批次貼圖') {
    sessions.set(userId, { flow: 'batchPhotoSelect', data: {} });
    return client.replyMessage(event.replyToken, buildStepMessage('請選擇要批次貼圖的報價類型', {
      quickReplyItems: [
        { label: '🇰🇷 韓國代購', text: '批次-韓國' },
        { label: '🇰🇷 韓免線上', text: '批次-韓免線上' },
        { label: '🇰🇷 韓免實體', text: '批次-韓免實體' },
        { label: '🇺🇸 美國代購', text: '批次-美國' },
      ],
    }));
  }

  if (text === '新增訂單') {
    const session = newSession('order');
    sessions.set(userId, session);
    const step = advance(ORDER_STEPS, session);
    return client.replyMessage(event.replyToken, buildStepMessage(stepPrompt(step, session), step));
  }

  if (text === '收款') {
    sessions.set(userId, { flow: 'collectPayment', step: 'awaitName', data: {} });
    return client.replyMessage(event.replyToken, buildStepMessage('請輸入客人姓名'));
  }

  if (text === '客戶明細') {
    sessions.set(userId, { flow: 'customerSummary', step: 'awaitName', data: {} });
    return client.replyMessage(event.replyToken, buildStepMessage('請輸入客人姓名'));
  }

  if (text === '改報價' || text === '改利潤') {
    sessions.set(userId, { flow: 'override', field: text === '改報價' ? 'quote' : 'profit', stepIndex: 0, data: {} });
    return client.replyMessage(event.replyToken, buildStepMessage('請輸入要修改的商品編號'));
  }

  const session = sessions.get(userId);
  if (!session) {
    return client.replyMessage(event.replyToken, buildStepMessage('輸入「同行報價」「韓國代購」「線上免稅店」「實體免稅店」或「美國代購」開始建立報價，輸入「批次貼圖」可以連續傳很多張照片快速建立商品（其他欄位事後回表格補），輸入「新增訂單」建立客人訂單，輸入「收款」標記客人已付款，輸入「客戶明細」查看客人的訂購明細連結，或輸入「改報價」「改利潤」修改已建立的商品。'));
  }

  if (session.flow === 'batchPhotoSelect') {
    const batchFlowMap = {
      '批次-韓國': 'koreaKrw',
      '批次-韓免線上': 'dutyFreeOnline',
      '批次-韓免實體': 'dutyFreePhysical',
      '批次-美國': 'usa',
    };
    if (batchFlowMap[text]) {
      sessions.set(userId, { flow: 'batchPhoto', data: { targetFlow: batchFlowMap[text], count: 0, productIds: [] } });
      return client.replyMessage(event.replyToken, buildStepMessage(
        `已選擇「${text.replace('批次-', '')}」批次貼圖模式📷\n請開始連續傳送商品照片，每張都會各自新增一筆，傳完後輸入「完成」結束（或輸入「取消」放棄這次）。`
      ));
    }
    return client.replyMessage(event.replyToken, buildStepMessage('請點選下方選單', {
      quickReplyItems: [
        { label: '🇰🇷 韓國代購', text: '批次-韓國' },
        { label: '🇰🇷 韓免線上', text: '批次-韓免線上' },
        { label: '🇰🇷 韓免實體', text: '批次-韓免實體' },
        { label: '🇺🇸 美國代購', text: '批次-美國' },
      ],
    }));
  }

  if (session.flow === 'batchPhoto') {
    if (text === '完成') {
      const pending = session.data.pending || 0;
      if (pending > 0) {
        return client.replyMessage(event.replyToken, buildStepMessage(`還有 ${pending} 張照片處理中，請稍等幾秒後再輸入一次「完成」。`));
      }
      const finalCount = session.data.count;
      const ids = session.data.productIds;
      sessions.delete(userId);
      if (finalCount === 0) {
        return client.replyMessage(event.replyToken, buildStepMessage('沒有收到任何照片，批次貼圖已結束。'));
      }
      const idRangeText = ids.length > 1 ? `${ids[0]} ～ ${ids[ids.length - 1]}` : ids[0];
      return client.replyMessage(event.replyToken, buildStepMessage(
        `✅ 批次貼圖完成，共新增 ${finalCount} 筆商品\n商品編號：${idRangeText}\n記得回表格幫每一筆補上品牌／商品名稱／價格等資料喔！`
      ));
    }

    if (event.message.type !== 'image') {
      return client.replyMessage(event.replyToken, buildStepMessage('請傳送商品照片📷，全部傳完後輸入「完成」結束。'));
    }

    session.data.pending = (session.data.pending || 0) + 1; // 在任何await之前先計數,確保「完成」進來時看得到「還有幾張在處理」
    try {
      const base64 = await getLineImageBase64(event.message.id);
      // 批次貼圖只有圖片這一個輸入,不像其他報價流程後面還有好幾步可以讓「先上傳圖片」的空檔被利用到,
      // 所以這裡直接把 base64 一次送給 batchAddImage,讓 Apps Script 那邊一次完成上傳+寫入,
      // 不要像其他流程一樣先呼叫 uploadImageToDrive 拿網址、再呼叫一次寫入,省掉一次 Apps Script 來回的等待時間。
      const result = await submitBatchAddImage(session.data.targetFlow, { imageBase64: base64 });
      session.data.count += 1;
      session.data.productIds.push(result.productId);
      session.data.pending -= 1;
      return client.replyMessage(event.replyToken, buildStepMessage(`✅ 第${session.data.count}張已新增（商品編號：${result.productId}）`));
    } catch (err) {
      session.data.pending -= 1;
      return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ 這張新增失敗：${err.message}\n可以重新傳一次這張，不影響前面已新增的。`));
    }
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
      const lines = ['✅ 已更新報價', `商品編號：${productId}`];
      if (result.oldTotal !== undefined && result.oldTotal !== '') lines.push(`原報價：${result.oldTotal}`);
      if (result.newTotal !== undefined) lines.push(`新報價：${result.newTotal}`);
      const messages = [buildStepMessage(lines.join('\n'))];
      if (result.brand && result.name && result.newTotal !== undefined) {
        messages.push(buildStepMessage(buildShortSummary(result.flag || '', result.brand, result.name, result.newTotal, result.color, result.size, result.style)));
      }
      return client.replyMessage(event.replyToken, messages);
    } catch (err) {
      return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}`));
    }
  }

  if (session.flow === 'peerSelect') {
    const flowMap = { 台幣報價: 'peerTwd', 韓幣報價: 'peerKrw', 日幣報價: 'peerJpy' };
    if (flowMap[text]) {
      session.flow = flowMap[text];
      session.stepIndex = 0;
      return client.replyMessage(event.replyToken, startFlowMessages(FLOWS[session.flow], session));
    }
    return client.replyMessage(
      event.replyToken,
      buildStepMessage('請點選下方選單：台幣報價／韓幣報價／日幣報價', {
        quickReplyItems: [
          { label: '🇹🇼 台幣報價', text: '台幣報價' },
          { label: '🇰🇷 韓幣報價', text: '韓幣報價' },
          { label: '🇯🇵 日幣報價', text: '日幣報價' },
        ],
      })
    );
  }

  if (session.flow === 'customerSummary') {
    const customerName = text.trim();
    sessions.delete(userId);
    let token;
    try {
      token = await fetchCustomerToken(customerName);
    } catch (err) {
      return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}`));
    }
    const url = `${APPS_SCRIPT_URL}?token=${token}`;
    return client.replyMessage(event.replyToken, buildStepMessage(`「${customerName}」的訂購明細⬇️\n${url}`));
  }

  if (session.flow === 'collectPayment') {
    const PAYMENT_METHODS = ['PC', 'LINE', '轉帳', '賣貨便/信用卡', '現金/小芳', '現金/宛柔'];

    if (session.step === 'awaitName') {
      const customerName = text;
      let unpaid;
      try {
        unpaid = await fetchUnpaidOrders(customerName);
      } catch (err) {
        sessions.delete(userId);
        return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}`));
      }
      if (!unpaid || unpaid.length === 0) {
        sessions.delete(userId);
        return client.replyMessage(event.replyToken, buildStepMessage(`「${customerName}」目前沒有未付款的訂單。`));
      }
      session.data.customerName = customerName;
      session.data.unpaidOrders = unpaid;
      session.step = 'awaitScope';

      const lines = [`「${customerName}」未付款訂單：`];
      let sum = 0;
      unpaid.forEach((o) => {
        lines.push(`${o.orderId}｜${o.name}${o.color ? '／' + o.color : ''}${o.size ? '／' + o.size : ''} x${o.quantity}｜$${o.total}`);
        sum += o.total;
      });
      lines.push('——————————');
      lines.push(`💰 未付總金額：${sum}`);

      return client.replyMessage(event.replyToken, [
        buildStepMessage(lines.join('\n')),
        buildStepMessage('請選擇付款範圍', {
          quickReplyItems: [
            { label: '✅ 全部付款', text: '全部付款' },
            { label: '☑️ 部分付款', text: '部分付款' },
          ],
        }),
      ]);
    }

    if (session.step === 'awaitScope') {
      if (text === '全部付款') {
        session.data.selectedOrderIds = session.data.unpaidOrders.map((o) => o.orderId);
        session.step = 'awaitPaymentMethod';
        return client.replyMessage(event.replyToken, buildStepMessage('請選擇付款方式', {
          quickReplyItems: PAYMENT_METHODS.map((m) => ({ label: m, text: m })),
        }));
      }
      if (text === '部分付款') {
        session.step = 'awaitOrderIds';
        return client.replyMessage(event.replyToken, buildStepMessage('請輸入要付款的訂單編號，多筆請用逗號分隔（例如：ORD0012，ORD0013）'));
      }
      return client.replyMessage(event.replyToken, buildStepMessage('請點選下方選單：全部付款／部分付款', {
        quickReplyItems: [
          { label: '✅ 全部付款', text: '全部付款' },
          { label: '☑️ 部分付款', text: '部分付款' },
        ],
      }));
    }

    if (session.step === 'awaitOrderIds') {
      const ids = text.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const validIds = session.data.unpaidOrders.map((o) => o.orderId);
      const invalid = ids.filter((id) => !validIds.includes(id));
      if (ids.length === 0 || invalid.length > 0) {
        return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ 訂單編號有誤或不在未付款清單裡：${invalid.join('、') || '（未輸入）'}\n請重新輸入`));
      }
      session.data.selectedOrderIds = ids;
      session.step = 'awaitPaymentMethod';
      return client.replyMessage(event.replyToken, buildStepMessage('請選擇付款方式', {
        quickReplyItems: PAYMENT_METHODS.map((m) => ({ label: m, text: m })),
      }));
    }

    if (session.step === 'awaitPaymentMethod') {
      if (!PAYMENT_METHODS.includes(text)) {
        return client.replyMessage(event.replyToken, buildStepMessage('請點選下方選單的付款方式', {
          quickReplyItems: PAYMENT_METHODS.map((m) => ({ label: m, text: m })),
        }));
      }
      let result;
      try {
        result = await markOrdersPaid(session.data.selectedOrderIds, text);
      } catch (err) {
        sessions.delete(userId);
        return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}`));
      }
      const paidTotal = session.data.unpaidOrders
        .filter((o) => session.data.selectedOrderIds.includes(o.orderId))
        .reduce((sum, o) => sum + o.total, 0);
      const allTotal = session.data.unpaidOrders.reduce((sum, o) => sum + o.total, 0);
      const remaining = allTotal - paidTotal;

      const lines = [`✅ 已標記付款（${text}）`, `客人：${session.data.customerName}`, `訂單編號：${session.data.selectedOrderIds.join('、')}`, `💰 本次付款：${paidTotal}`];
      if (remaining > 0) lines.push(`💰 尚未付款：${remaining}`);
      sessions.delete(userId);
      return client.replyMessage(event.replyToken, buildStepMessage(lines.join('\n')));
    }
  }


  const steps = FLOWS[session.flow];
  const currentStep = steps[session.stepIndex];

  if (currentStep.type === 'image') {
    if (event.message.type !== 'image') {
      return client.replyMessage(event.replyToken, buildStepMessage('請傳送圖片，不是文字喔📷', currentStep));
    }
  } else if (event.message.type !== 'text') {
    return client.replyMessage(event.replyToken, buildStepMessage('請用文字輸入，或點選下方選單', currentStep));
  }

  try {
    if (currentStep.type === 'image') {
      const base64 = await getLineImageBase64(event.message.id);
      try {
        session.data.imageUrl = await uploadImageToDrive(base64);
      } catch (uploadErr) {
        session.data.imageBase64 = base64; // 立即上傳失敗就退回舊做法,最後一步再讓 Apps Script 處理
      }
    } else if (currentStep.type === 'orderItems') {
      const parsed = parseOrderTemplate(text);
      Object.assign(session.data, parsed);
    } else if (currentStep.type === 'template') {
      const dynDefaults = currentStep.dynamicDefaultsFn ? currentStep.dynamicDefaultsFn(session) : {};
      const parsed = parseTemplate(text, currentStep.fields, dynDefaults);
      Object.assign(session.data, parsed);
      // 同行報價-台幣:重量沒填就視為已含運費,每公斤運費強制歸零
      if ((session.flow === 'peerTwd' || session.flow === 'peerJpy') && (session.data.weight === null || session.data.weight === undefined)) {
        session.data.shippingRate = 0;
      }
      if (session.flow === 'koreaKrw' && !session.data.location) {
        session.data.location = session.data.brand;
      }
      if (session.flow === 'dutyFreeOnline' || session.flow === 'dutyFreePhysical') {
        let lowestPrice = null;
        let lowestStore = null;
        Object.keys(DUTY_FREE_STORES).forEach((key) => {
          const val = session.data[key];
          if (val !== null && val !== undefined && (lowestPrice === null || val < lowestPrice)) {
            lowestPrice = val;
            lowestStore = DUTY_FREE_STORES[key];
          }
        });
        if (lowestPrice === null) {
          throw new Error('至少要填一間店的售價，請重新整段貼上');
        }
        session.data.lowestPrice = lowestPrice;
        session.data.lowestStore = lowestStore;
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
      let promptMessage;
      if (currentStep.type === 'image' && session.templatePreShown && nextStep.type === 'template') {
        promptMessage = buildStepMessage('📷 圖片收到，請貼上你填好的資料');
        session.templatePreShown = false;
      } else {
        promptMessage = buildStepMessage(stepPrompt(nextStep, session), nextStep);
      }
      const messages = [...extraMessages.map((t) => buildStepMessage(t)), promptMessage];
      return client.replyMessage(event.replyToken, messages);
    }

    // 全部欄位收集完成,先用「試算模式」快速算出報價(不寫入表格),立刻回覆給使用者
    const dryRunResult = await submitToAppsScript(session.flow, session.data, true);
    const finalData = session.data;
    const finalFlow = session.flow;
    sessions.delete(userId);
    const messages = [...extraMessages.map((t) => buildStepMessage(t)), buildStepMessage(buildQuoteMessage(finalFlow, finalData, dryRunResult))];
    if (finalFlow !== 'order') {
      const flag = flagForFlow(finalFlow, finalData);
      messages.push(buildStepMessage(buildShortSummary(flag, finalData.brand, finalData.name, dryRunResult.total, finalData.color, finalData.size, finalData.style)));
    }
    await client.replyMessage(event.replyToken, messages);

    // 背景真正寫入試算表,完成後用推播訊息補上商品編號(不 await,不擋住剛剛的回覆)
    // 沒有收到這則補充訊息,就代表這筆沒有真的成立,需要重新送出一次。
    submitToAppsScript(finalFlow, finalData, false)
      .then((result) => {
        const idText = finalFlow === 'order'
          ? result.orders.map((o) => o.orderId).join('、')
          : String(result.productId);
        const label = finalFlow === 'order' ? '訂單編號' : '商品編號';
        return client.pushMessage(userId, [
          buildStepMessage(`✅ 已成立\n${label}⬇️`),
          buildStepMessage(idText),
        ]);
      })
      .catch((err) => {
        return client.pushMessage(userId, buildStepMessage(`⚠️ 剛剛那筆寫入試算表失敗：${err.message}\n請重新送出一次`));
      });

    return;
  } catch (err) {
    return client.replyMessage(event.replyToken, buildStepMessage(`⚠️ ${err.message}\n\n${stepPrompt(currentStep, session)}`, currentStep));
  }
}

async function submitToAppsScript(flow, data, dryRun) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, recordType: flow, dryRun: !!dryRun, ...data }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Apps Script 回應格式錯誤，請確認網址與部署設定');
  }
  if (!json.success) {
    throw new Error(json.error || '寫入試算表失敗');
  }
  return json; // { success, productId?, total, shippingRatePerKg?, baseCost, shippingCost }
}

async function submitBatchAddImage(targetFlow, imagePayload) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action: 'batchAddImage', targetFlow, ...imagePayload }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Apps Script 回應格式錯誤，請確認網址與部署設定');
  }
  if (!json.success) {
    throw new Error(json.error || '新增失敗');
  }
  return json; // { success, productId }
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
    throw new Error('Apps Script 回應格式錯誤，請確認網址與部署設定');
  }
  if (!json.success) {
    throw new Error(json.error || '更新失敗');
  }
  return json; // { success, productId, newTotal }
}

async function fetchUnpaidOrders(customerName) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action: 'listUnpaid', customerName }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Apps Script 回應格式錯誤，請確認網址與部署設定');
  }
  if (!json.success) {
    throw new Error(json.error || '查詢失敗');
  }
  return json.orders; // [{ orderId, name, color, size, style, quantity, total }]
}

async function markOrdersPaid(orderIds, paymentMethod) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action: 'markPaid', orderIds, paymentMethod }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Apps Script 回應格式錯誤，請確認網址與部署設定');
  }
  if (!json.success) {
    throw new Error(json.error || '更新失敗');
  }
  return json;
}

function costLine(result) {
  const sum = result.baseCost + result.shippingCost;
  return `💰 商品成本：${result.baseCost}+${result.shippingCost}=${sum}`;
}

function buildQuoteMessage(flow, data, result) {
  if (flow === 'order') {
    const lines = ['✅ 訂購表單新增完成', `客人：${data.customerName}`];
    result.orders.forEach((o) => {
      lines.push('——————————');
      if (o.type === 'product') {
        lines.push(`商品編號：${o.identifier}`);
        lines.push(`品牌：${o.brand}`);
        lines.push(`名稱：${o.name}`);
        if (o.color) lines.push(`顏色：${o.color}`);
        if (o.size) lines.push(`尺寸：${o.size}`);
        if (o.style) lines.push(`款式：${o.style}`);
      } else {
        lines.push(`項目：${o.name}`);
      }
      lines.push(`數量：${o.quantity}`);
      lines.push(`單價：${o.unitPrice}`);
      lines.push(`小計：${o.total}`);
    });
    lines.push('——————————');
    if (data.paymentMethod) lines.push(`付款方式：${data.paymentMethod}`);
    lines.push(`已收款：${data.received ? '是' : '否'}`);
    lines.push(`💰 總金額：${result.grandTotal}`);
    return lines.join('\n');
  }

  if (flow === 'dutyFreeOnline' || flow === 'dutyFreePhysical') {
    const isPhysical = flow === 'dutyFreePhysical';
    const title = isPhysical ? '✅ 免稅店實體報價完成' : '✅ 免稅店線上報價完成';
    const d1 = data.discount1 ? 1 - data.discount1 / 100 : 1;
    const d2 = data.discount2 ? 1 - data.discount2 / 100 : 1;

    const lines = [title, '編號：確認中（稍後補上）', `品牌：${data.brand}`, `名稱：${data.name}`];
    if (data.color) lines.push(`顏色：${data.color}`);
    if (data.size) lines.push(`尺寸：${data.size}`);
    if (data.style) lines.push(`款式：${data.style}`);
    if (data.note) lines.push(`備註：${data.note}`);

    const filledStores = Object.keys(DUTY_FREE_STORES).filter((key) => data[key] !== null && data[key] !== undefined);
    const storeLines = filledStores.map((key) => `${DUTY_FREE_STORES[key]}：${data[key]}`);
    lines.push(`各店售價：${storeLines.join('、')}`);
    lines.push(`最低售價：${data.lowestPrice}（${data.lowestStore}，匯率 1美金：${data.fxRate}）`);
    if (isPhysical) {
      if (data.discount1 !== null && data.discount1 !== undefined) lines.push(`折扣1（金卡）：${data.discount1}%`);
      if (data.discount2 !== null && data.discount2 !== undefined) lines.push(`折扣2（返點）：${data.discount2}%`);
    }
    if (data.weight !== null && data.weight !== undefined) {
      lines.push(`重量：${data.weight} kg`);
    } else {
      lines.push('重量：未填（親飛帶回）');
    }
    lines.push(`類別：${data.category}（每公斤運費 ${result.shippingRatePerKg}，韓國運費 ${data.koreaShippingFee} 韓幣）`);
    lines.push(`利潤：${data.profit}`);
    lines.push('——————————');

    // 每一間有填售價的店都各自算一次報價,由低到高排序,方便缺貨時知道改用哪家的價格
    const sortedStores = [...filledStores].sort((a, b) => data[a] - data[b]);
    sortedStores.forEach((key) => {
      const storePrice = data[key];
      const baseCost = Math.round(storePrice * d1 * d2 * data.fxRate);
      const totalCost = baseCost + result.shippingCost;
      const quote = ceilTo10(totalCost + data.profit);
      lines.push(DUTY_FREE_STORES[key]);
      lines.push(`💰 建議報價：${quote}`);
      lines.push(`💰 商品總成本：${baseCost}+${result.shippingCost}=${totalCost}`);
      lines.push('');
    });
    if (lines[lines.length - 1] === '') lines.pop();

    return lines.join('\n');
  }

  if (flow === 'usa') {
    const lines = ['✅ 美國代購報價完成', '編號：確認中（稍後補上）', `購買地點：${data.location}`, `品牌：${data.brand}`, `名稱：${data.name}`];
    if (data.link) lines.push(`連結：${data.link}`);
    if (data.color) lines.push(`顏色：${data.color}`);
    if (data.size) lines.push(`尺寸：${data.size}`);
    if (data.style) lines.push(`款式：${data.style}`);
    if (data.note) lines.push(`備註：${data.note}`);
    if (data.originalPrice !== null && data.originalPrice !== undefined) {
      lines.push(`原價：${data.originalPrice}`);
    }
    lines.push(`售價：${data.price}（匯率 1美金：${data.fxRate}）`);
    lines.push(`買手費：${data.buyerFeePercent}%`);
    if (data.weight !== null && data.weight !== undefined) {
      lines.push(`重量：${data.weight} kg，運費：每磅$${data.shippingFeePerLb}，包材費：$${data.packagingFee}`);
    } else {
      lines.push('重量：未填（親飛帶回，運費、包材費都不收）');
    }
    lines.push(`利潤：${data.profit}`);
    lines.push('——————————');
    lines.push(`💰 建議報價：${result.total}`);
    lines.push(`💰 商品總成本：${result.baseCost}+${result.shippingCost}=${result.baseCost + result.shippingCost}`);
    if (result.originalQuote !== null && result.originalQuote !== undefined) {
      lines.push(`💰 原價報價（參考）：${result.originalQuote}`);
    }
    return lines.join('\n');
  }

  if (flow === 'koreaKrw') {
    const lines = ['✅ 韓幣報價完成', '編號：確認中（稍後補上）', `購買地點：${data.location}`, `品牌：${data.brand}`, `名稱：${data.name}`];
    if (data.link) lines.push(`連結：${data.link}`);
    if (data.color) lines.push(`顏色：${data.color}`);
    if (data.size) lines.push(`尺寸：${data.size}`);
    if (data.style) lines.push(`款式：${data.style}`);
    if (data.note) lines.push(`備註：${data.note}`);
    if (data.originalPrice !== null && data.originalPrice !== undefined) {
      lines.push(`原價：${data.originalPrice}`);
    }
    lines.push(`售價：${data.price}（匯率 1：${data.fxRate}）`);
    if (data.weight !== null && data.weight !== undefined) {
      lines.push(`重量：${data.weight} kg`);
    } else {
      lines.push('重量：未填（親飛帶回）');
    }
    lines.push(`類別：${data.category}（每公斤運費 ${result.shippingRatePerKg}，韓國運費 ${data.koreaShippingFee} 韓幣）`);
    lines.push(`利潤：${data.profit}`);
    lines.push('——————————');
    lines.push(`💰 建議報價：${result.total}`);
    lines.push(`💰 商品總成本：${result.baseCost}+${result.shippingCost}=${result.baseCost + result.shippingCost}`);
    if (result.originalQuote !== null && result.originalQuote !== undefined) {
      lines.push(`💰 原價報價（參考）：${result.originalQuote}`);
    }
    return lines.join('\n');
  }

  if (flow === 'peerTwd') {
    const lines = ['✅ 同行報價完成（台幣）', '編號：確認中（稍後補上）', `同行：${data.peerName}`, `品牌：${data.brand}`, `名稱：${data.name}`];
    if (data.link) lines.push(`連結：${data.link}`);
    if (data.color) lines.push(`顏色：${data.color}`);
    if (data.size) lines.push(`尺寸：${data.size}`);
    if (data.style) lines.push(`款式：${data.style}`);
    if (data.note) lines.push(`備註：${data.note}`);
    if (data.originalPrice !== null && data.originalPrice !== undefined) {
      lines.push(`原價：${data.originalPrice}`);
    }
    lines.push(`售價：${data.price}`);
    if (data.weight) {
      lines.push(`重量：${data.weight} kg，每公斤運費：${data.shippingRate}`);
    } else {
      lines.push('重量：未填（售價已含運費）');
    }
    lines.push(`利潤：${data.profit}`);
    lines.push('——————————');
    lines.push(`💰 建議報價：${result.total}`);
    lines.push(costLine(result));
    if (result.originalQuote !== null && result.originalQuote !== undefined) {
      lines.push(`💰 原價報價（參考）：${result.originalQuote}`);
    }
    return lines.join('\n');
  }

  const peerCurrencyLabel = flow === 'peerJpy' ? '日幣' : '韓幣';
  const lines = [
    `✅ 同行報價完成（${peerCurrencyLabel}）`,
    '編號：確認中（稍後補上）',
    `同行：${data.peerName}`,
    `品牌：${data.brand}`,
    `名稱：${data.name}`,
  ];
  if (data.link) lines.push(`連結：${data.link}`);
  if (data.color) lines.push(`顏色：${data.color}`);
  if (data.size) lines.push(`尺寸：${data.size}`);
  if (data.style) lines.push(`款式：${data.style}`);
  if (data.note) lines.push(`備註：${data.note}`);
  if (data.originalPrice !== null && data.originalPrice !== undefined) {
    lines.push(`原價：${data.originalPrice}`);
  }
  lines.push(`售價：${data.price}（同行匯率 1：${data.peerRate}）`);
  if (data.buyerFeePercent !== null && data.buyerFeePercent !== undefined) {
    lines.push(`買手費：${data.buyerFeePercent}%`);
  }
  if (data.weight !== null && data.weight !== undefined) {
    lines.push(`重量：${data.weight} kg，每公斤運費：${data.shippingRate}`);
  } else {
    lines.push('重量：未填（親飛帶回）');
  }
  lines.push(`利潤：${data.profit}`);
  lines.push('——————————');
  lines.push(`💰 建議報價：${result.total}`);
  lines.push(costLine(result));
  if (result.originalQuote !== null && result.originalQuote !== undefined) {
    lines.push(`💰 原價報價（參考）：${result.originalQuote}`);
  }
  return lines.join('\n');
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
