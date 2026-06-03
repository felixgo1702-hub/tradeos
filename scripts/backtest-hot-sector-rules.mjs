const PROXY_BASE = "https://tradeos-felixgo1702-8696s-projects.vercel.app/api/proxy?url=";
const END_DATE = process.env.BACKTEST_END || "2026-06-04";
const SECTOR_STOCK_LIMIT = Number(process.env.SECTOR_STOCK_LIMIT || 50);
const CONCURRENCY = Number(process.env.BACKTEST_CONCURRENCY || 18);
const REQUEST_TIMEOUT = Number(process.env.BACKTEST_TIMEOUT || 9000);
const KLINE_SOURCE = process.env.KLINE_SOURCE || "eastmoney";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const proxied = (url) => `${PROXY_BASE}${encodeURIComponent(url)}`;

async function fetchJson(url, { proxy = false, tries = 3 } = {}) {
  let lastError;
  for (let index = 0; index < tries; index += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(proxy ? proxied(url) : url, {
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0" },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 80)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      await sleep(300 * (index + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const result = [];
  values.forEach((value, index) => {
    result[index] = index ? value * k + result[index - 1] * (1 - k) : value;
  });
  return result;
}

function getMacd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = ema12.map((value, index) => value - ema26[index]);
  const dea = ema(dif, 9);
  const last = dif.length - 1;
  const hist = dif.map((value, index) => (value - dea[index]) * 2);
  return {
    isGolden: dif[last] > dea[last],
    justGolden: dif[last] > dea[last] && dif[last - 1] <= dea[last - 1],
    rising: dif[last] > dif[last - 1],
    latestDiff: dif[last],
    latestHist: hist[last],
  };
}

function scoreRange(value, min, max, full) {
  if (value < min || value > max) {
    const distance = value < min ? min - value : value - max;
    return Math.max(0, full - distance * (full / 2));
  }
  const middle = (min + max) / 2;
  const half = (max - min) / 2 || 1;
  return full - (Math.abs(value - middle) / half) * (full * 0.15);
}

function formatNumber(value) {
  return Number(value || 0).toFixed(2);
}

function formatPct(value) {
  return `${formatNumber(value)}%`;
}

function percent(value, total) {
  return total ? `${Math.round((value / total) * 100)}%` : "0%";
}

function getAmplitude(stock) {
  return stock.prevClose ? ((stock.high - stock.low) / stock.prevClose) * 100 : 0;
}

function getVolumeTrend(volumes) {
  if (volumes.length < 6) return "数据不足";
  const recent = volumes.slice(-3);
  if (recent[2] > recent[1] && recent[1] > recent[0]) return "台阶放量";
  return recent[2] > avg(volumes.slice(-5)) ? "放量" : "未放量";
}

function countConsecutiveUp(klines) {
  let count = 0;
  for (let index = klines.length - 1; index >= 0; index -= 1) {
    if (klines[index].close > klines[index].open) count += 1;
    else break;
  }
  return count;
}

function getRecentLimitUp(klines, days) {
  const recent = klines.slice(-days);
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index];
    if (item.pct >= 9.5) return { ...item, daysAgo: recent.length - 1 - index };
  }
  return null;
}

function hasConsecutiveBearish(klines) {
  const recent = klines.slice(-2);
  return recent.length === 2 && recent.every((item) => item.close < item.open);
}

function hasLongUpperShadow(kline) {
  const bodyHigh = Math.max(kline.open, kline.close);
  const body = Math.abs(kline.close - kline.open) || 0.01;
  const upperShadow = kline.high - bodyHigh;
  return upperShadow / body >= 2 && upperShadow / kline.close > 0.03;
}

function passBaseAmountPool(stock, relaxed = false) {
  const risky = /ST|退|^N|Ｂ|B/.test(stock.name);
  const minFloatValue = relaxed ? 2000000000 : 3000000000;
  const maxFloatValue = relaxed ? 50000000000 : 30000000000;
  return (
    !risky &&
    /^(00|60)/.test(stock.code) &&
    stock.price >= 3 &&
    Number.isFinite(stock.amount) &&
    stock.amount > 0 &&
    stock.floatValue >= minFloatValue &&
    stock.floatValue <= maxFloatValue
  );
}

function passFastFilter(stock, relaxed = false, amountTopCodes = null, hotSectorNames = null) {
  const risky = /ST|退|^N|Ｂ|B/.test(stock.name);
  const amplitude = getAmplitude(stock);
  if (amountTopCodes && !amountTopCodes.has(stock.code)) return false;
  if (hotSectorNames && !hotSectorNames.has(stock.industry)) return false;
  if (relaxed) {
    return (
      !risky &&
      stock.price >= 3 &&
      stock.amount >= 20000000 &&
      stock.pct >= -2 &&
      stock.pct <= 8 &&
      stock.floatValue >= 2000000000 &&
      stock.floatValue <= 50000000000 &&
      stock.turnover >= 1.5 &&
      stock.turnover <= 20 &&
      (stock.volumeRatio === 0 || stock.volumeRatio >= 0.8) &&
      amplitude <= 12
    );
  }
  return (
    !risky &&
    stock.price >= 3 &&
    stock.amount >= 50000000 &&
    stock.pct >= 1 &&
    stock.pct <= 5.8 &&
    stock.floatValue >= 3000000000 &&
    stock.floatValue <= 30000000000 &&
    stock.turnover >= 4 &&
    stock.turnover <= 12 &&
    (stock.volumeRatio === 0 || stock.volumeRatio >= 1) &&
    amplitude <= 8
  );
}

function getHotSectors(stocks, size = 5) {
  const map = new Map();
  stocks.forEach((item) => {
    const name = item.industry || "未分类";
    if (!name || ["未分类", "新浪行情"].includes(name)) return;
    const old = map.get(name) || { name, count: 0, pct: 0, amount: 0, up: 0, strong: 0 };
    old.count += 1;
    old.pct += item.pct;
    old.amount += item.amount || 0;
    if (item.pct > 0) old.up += 1;
    if (item.pct >= 5) old.strong += 1;
    map.set(name, old);
  });
  return [...map.values()]
    .filter((item) => item.count >= 2)
    .map((item) => {
      const avgPct = item.pct / item.count;
      const upRatio = item.up / item.count;
      const score = avgPct * 2 + upRatio * 8 + item.amount / 10000000000 + item.strong * 0.8 + item.count * 0.2;
      return { ...item, avgPct, upRatio, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, size)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function scoreStock(stock, klines) {
  if (klines.length < 30) return null;
  const closes = klines.map((item) => item.close);
  const volumes = klines.map((item) => item.volume);
  const latest = klines.at(-1);
  const ma5 = avg(closes.slice(-5));
  const ma10 = avg(closes.slice(-10));
  const ma20 = avg(closes.slice(-20));
  const multiMa = ma5 > ma10 && ma10 > ma20;
  const consecutiveUp = countConsecutiveUp(klines);
  const recentLimitUp = getRecentLimitUp(klines, 10);
  const pullbackFromLimitUp = recentLimitUp ? ((recentLimitUp.close - stock.price) / recentLimitUp.close) * 100 : 99;
  const volume5 = avg(volumes.slice(-5));
  const volume20 = avg(volumes.slice(-20));
  const volumeExpansion = volume5 > volume20 * 1.2;
  if (!multiMa || stock.price < ma5 || consecutiveUp >= 3 || hasConsecutiveBearish(klines) || hasLongUpperShadow(latest)) return null;
  const macd = getMacd(closes);
  const macdZeroRed = macd.latestDiff > 0 && macd.latestHist > 0;
  const volumeTrend = getVolumeTrend(volumes);
  const floatYi = stock.floatValue / 100000000;
  const amplitude = latest.amplitude || getAmplitude(stock);
  const sector = stock.hotSector || null;
  let score = 0;
  const reasons = [];

  score += scoreRange(stock.pct, 3, 5, 20);
  score += Math.min(12, Math.max(0, (stock.volumeRatio - 1) * 6 + 6));
  score += scoreRange(stock.turnover, 5, 10, 18);
  score += scoreRange(floatYi, 30, 300, 12);
  score += volumeTrend === "台阶放量" ? 12 : volumeTrend === "放量" ? 7 : 0;
  score += recentLimitUp ? 8 : 0;
  score += pullbackFromLimitUp <= 8 ? 6 : 0;
  score += volumeExpansion ? 8 : 0;
  score += 12;
  score += macdZeroRed ? 10 : macd.justGolden ? 8 : macd.isGolden && macd.rising ? 6 : 0;
  score += Math.max(0, 8 - Math.max(0, amplitude - 5) * 2);
  score += sector ? (sector.rank <= 3 ? 10 : 6) : 0;
  score = Math.round(Math.max(0, Math.min(100, score)));
  if (score < 68) return null;

  if (sector) reasons.push(`热门板块TOP${sector.rank}:${sector.name}`);
  if (stock.pct >= 3 && stock.pct <= 5) reasons.push("涨幅3%-5%");
  else reasons.push("涨幅不在核心区间");
  if (recentLimitUp) reasons.push(`近10天涨停${recentLimitUp.daysAgo}天前`);
  if (pullbackFromLimitUp <= 8) reasons.push("涨停回调<=8%");
  if (volumeExpansion) reasons.push("5日量>20日量*1.2");
  if (macdZeroRed) reasons.push("MACD零轴上红柱");
  else if (macd.justGolden) reasons.push("MACD刚金叉");
  if (volumeTrend !== "未放量") reasons.push(`成交量${volumeTrend}`);

  return {
    ...stock,
    score,
    priority: score >= 82 ? "A级" : score >= 68 ? "B级" : "C级",
    reasons,
  };
}

function normalizeSinaStock(raw, industry) {
  const stock = {
    code: String(raw.code || "").replace(/^(sh|sz)/, ""),
    name: raw.name,
    price: toNumber(raw.trade),
    pct: toNumber(raw.changepercent),
    volume: toNumber(raw.volume),
    amount: toNumber(raw.amount),
    turnover: toNumber(raw.turnoverratio),
    volumeRatio: 1,
    high: toNumber(raw.high),
    low: toNumber(raw.low),
    open: toNumber(raw.open),
    prevClose: toNumber(raw.settlement),
    totalValue: toNumber(raw.mktcap) * 10000,
    floatValue: toNumber(raw.nmc) * 10000,
    industry,
    source: "新浪行业行情",
  };
  if (!/^(00|60)/.test(stock.code) || !stock.price) return null;
  return stock;
}

async function fetchSinaIndustryNodes() {
  const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodes";
  const json = await fetchJson(url);
  const groups = json?.[1]?.find((item) => item?.[0] === "A股")?.[1] || [];
  const industries = groups.find((item) => item?.[0] === "新浪行业")?.[1] || [];
  return industries.map(([name, , node]) => ({ name, node })).filter((item) => item.name && item.node);
}

async function fetchSectorStocks() {
  const nodes = await fetchSinaIndustryNodes();
  console.log(`读取行业板块 ${nodes.length} 个，每个板块取成交额前 ${SECTOR_STOCK_LIMIT} 只`);
  const batches = await mapLimit(nodes, 8, async (sector) => {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=${SECTOR_STOCK_LIMIT}&sort=amount&asc=0&node=${sector.node}&symbol=&_s_r_a=page`;
    const json = await fetchJson(url);
    return Array.isArray(json) ? json.map((item) => normalizeSinaStock(item, sector.name)).filter(Boolean) : [];
  });
  const map = new Map();
  batches.flat().filter(Boolean).forEach((stock) => {
    const old = map.get(stock.code);
    if (!old || stock.amount > old.amount) map.set(stock.code, stock);
  });
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

async function fetchKlines(code, marketId, limit = 160, period = 101) {
  if (KLINE_SOURCE === "sina") return fetchSinaKlines(code, marketId, limit);
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${marketId}.${code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${period}&fqt=1&beg=20200101&end=${END_DATE.replaceAll("-", "")}&lmt=${limit}`;
  let json;
  try {
    json = await fetchJson(url, { proxy: true, tries: 3 });
  } catch {
    return fetchSinaKlines(code, marketId, limit);
  }
  return (json.data?.klines || []).map((line) => {
    const [dateTime, open, close, high, low, volume, amount, amplitude, pct, turnover] = line.split(",");
    return {
      dateTime,
      date: dateTime.slice(0, 10),
      time: dateTime.slice(11, 16),
      open: +open,
      close: +close,
      high: +high,
      low: +low,
      volume: +volume,
      amount: +amount,
      amplitude: +amplitude,
      pct: +pct,
      turnover: +turnover,
    };
  });
}

async function fetchSinaKlines(code, marketId, limit = 160) {
  const symbol = `${marketId === 1 ? "sh" : "sz"}${code}`;
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${limit}`;
  const rows = await fetchJson(url, { tries: 3 });
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const open = +row.open;
    const close = +row.close;
    const high = +row.high;
    const low = +row.low;
    const volume = +row.volume;
    const previousClose = index ? +rows[index - 1].close : open;
    const amount = close * volume;
    return {
      dateTime: row.day,
      date: row.day,
      time: "",
      open,
      close,
      high,
      low,
      volume,
      amount,
      amplitude: previousClose ? ((high - low) / previousClose) * 100 : 0,
      pct: previousClose ? ((close - previousClose) / previousClose) * 100 : 0,
      turnover: 0,
    };
  });
}

async function fetchTrends(code, marketId) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${marketId}.${code}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=5`;
  const json = await fetchJson(url, { proxy: true, tries: 2 });
  return (json.data?.trends || []).map((line) => {
    const [dateTime, , price, avgPrice, volume, amount] = line.split(",");
    return {
      date: dateTime.slice(0, 10),
      time: dateTime.slice(11, 16),
      price: +price,
      avgPrice: +avgPrice,
      volume: +volume,
      amount: +amount,
    };
  });
}

function historicalStockOnDate(stock, date) {
  const index = stock.klines.findIndex((item) => item.date === date);
  const latest = stock.klines[index];
  const previous = stock.klines[index - 1];
  if (!latest || !previous) return null;
  const prevVolumes = stock.klines.slice(Math.max(0, index - 5), index).map((item) => item.volume);
  const volumeRatio = prevVolumes.length ? latest.volume / avg(prevVolumes) : 1;
  const floatShares = stock.price ? stock.floatValue / stock.price : 0;
  const turnover = latest.turnover || (floatShares ? (latest.volume / floatShares) * 100 : stock.turnover);
  return {
    ...stock,
    price: latest.close,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    prevClose: previous.close,
    pct: latest.pct,
    amount: latest.amount,
    volume: latest.volume,
    turnover,
    volumeRatio,
  };
}

function buildConfirmation(candidate, current) {
  if (!current) {
    return { ...candidate, confirmScore: 0, confirmPassed: false, confirmReasons: ["没有确认行情"] };
  }
  let score = 0;
  const reasons = [];
  const openPct = candidate.prevClose ? ((current.open - candidate.prevClose) / candidate.prevClose) * 100 : ((current.open - candidate.price) / candidate.price) * 100;
  const openStrength = openPct >= -2 && openPct <= 3;
  const holdingCandidatePrice = current.price >= candidate.price;
  const aboveIntradayAvg = current.avgPrice ? current.price > current.avgPrice : current.price > current.open;
  const redOrStrong = current.pct > 0 || current.price > current.open || aboveIntradayAvg;
  const volumeRatioActive = current.volumeRatio >= 2;
  const intradayMacdHardOk = current.intradayMacdStrong !== false;
  const notWeakOpen = openPct >= -2;
  const noMorningTrap = !(current.high > current.open * 1.03 && current.price < current.open);
  const volumeActive = current.amount >= 50000000 || current.turnover >= 4;

  if (openStrength) { score += 22; reasons.push("开盘合格"); } else reasons.push("开盘不合格");
  if (holdingCandidatePrice) { score += 16; reasons.push("守住候选价"); } else reasons.push("跌破候选价");
  if (aboveIntradayAvg) { score += 18; reasons.push("分时均线加分"); } else reasons.push("未站上分时均线但不淘汰");
  if (volumeRatioActive) { score += 18; reasons.push("量比>=2"); } else reasons.push("量比不足2");
  reasons.push(current.intradayMacdLabel || "分钟MACD数据不足，不作为硬淘汰");
  if (redOrStrong) { score += 8; reasons.push("趋势未弱"); } else reasons.push("趋势偏弱");
  if (notWeakOpen) { score += 8; reasons.push("未低开超2%"); } else reasons.push("低开超2%");
  if (noMorningTrap) { score += 14; reasons.push("无明显诱多"); } else reasons.push("冲高回落");
  if (volumeActive) { score += 4; reasons.push("成交活跃"); }

  score = Math.round(Math.max(0, Math.min(100, score)));
  return {
    ...candidate,
    current,
    confirmScore: score,
    confirmPassed: score >= 72 && openStrength && holdingCandidatePrice && volumeRatioActive && intradayMacdHardOk && notWeakOpen && noMorningTrap,
    confirmReasons: reasons,
  };
}

async function confirmCandidate(candidate, confirmDate) {
  const marketId = candidate.code.startsWith("6") ? 1 : 0;
  const dailyIndex = candidate.klines.findIndex((item) => item.date === confirmDate);
  const daily = candidate.klines[dailyIndex];
  if (!daily) return null;
  let morning = [];
  try {
    morning = (await fetchTrends(candidate.code, marketId)).filter((item) => item.date === confirmDate && item.time >= "09:30" && item.time <= "10:00");
  } catch {
    morning = [];
  }
  const prevVolumes = candidate.klines.slice(Math.max(0, dailyIndex - 5), dailyIndex).map((item) => item.volume);
  const volumeRatio = prevVolumes.length ? daily.volume / avg(prevVolumes) : candidate.volumeRatio || 1;
  if (!morning.length) {
    return buildConfirmation(candidate, {
      open: daily.open,
      price: daily.close,
      avgPrice: daily.open,
      high: daily.high,
      amount: daily.amount,
      volumeRatio,
      turnover: daily.turnover || candidate.turnover,
      pct: daily.open ? ((daily.close - daily.open) / daily.open) * 100 : 0,
      intradayMacdStrong: null,
      intradayMacdLabel: "未取到10点分时，使用日线近似",
    });
  }
  const last = morning.at(-1);
  return buildConfirmation(candidate, {
    open: daily.open,
    price: last.price,
    avgPrice: last.avgPrice,
    high: Math.max(...morning.map((item) => item.price)),
    amount: morning.reduce((sum, item) => sum + item.amount, 0),
    volumeRatio,
    turnover: daily.turnover || candidate.turnover,
    pct: daily.open ? ((last.price - daily.open) / daily.open) * 100 : 0,
    intradayMacdStrong: null,
    intradayMacdLabel: "分钟MACD数据不足，不作为硬淘汰",
  });
}

function getAmountTopCodes(stocks, relaxed = false) {
  const ranked = stocks.filter((stock) => passBaseAmountPool(stock, relaxed)).sort((a, b) => b.amount - a.amount).slice(0, 30);
  ranked.forEach((stock, index) => {
    stock.amountRank = index + 1;
  });
  return new Set(ranked.map((stock) => stock.code));
}

async function main() {
  const stocks = await fetchSectorStocks();
  console.log(`去重后股票 ${stocks.length} 只，开始读取历史日线`);
  const withKlines = (await mapLimit(stocks, CONCURRENCY, async (stock, index) => {
    const marketId = stock.code.startsWith("6") ? 1 : 0;
    const klines = await fetchKlines(stock.code, marketId);
    if ((index + 1) % 100 === 0) console.error(`历史日线进度 ${index + 1}/${stocks.length}`);
    return klines.length ? { ...stock, klines } : null;
  })).filter(Boolean);
  console.log(`可回测股票 ${withKlines.length} 只`);

  const tradingDates = [...new Set(withKlines.flatMap((stock) => stock.klines.map((item) => item.date)))]
    .filter((date) => date >= "2026-05-20" && date <= END_DATE)
    .sort();
  const candidateDates = tradingDates.slice(-6, -1);
  console.log(`回测交易日：${candidateDates.join("、")}，确认到：${tradingDates.at(-1)}`);

  const summaries = [];
  for (const date of candidateDates) {
    const confirmDate = tradingDates[tradingDates.indexOf(date) + 1];
    const dayStocks = withKlines.map((stock) => historicalStockOnDate(stock, date)).filter(Boolean);
    const hotSectors = getHotSectors(dayStocks, 5);
    const hotSectorNames = new Set(hotSectors.map((sector) => sector.name));
    const hotSectorMap = new Map(hotSectors.map((sector) => [sector.name, sector]));
    dayStocks.forEach((stock) => {
      stock.hotSector = hotSectorMap.get(stock.industry) || null;
    });
    const amountTopCodes = getAmountTopCodes(dayStocks, false);
    const hotPoolCount = dayStocks.filter((item) => hotSectorNames.has(item.industry)).length;
    const fastPool = dayStocks.filter((item) => passFastFilter(item, false, amountTopCodes, hotSectorNames));
    const candidates = [];
    for (const stock of fastPool.slice(0, 160)) {
      const scored = scoreStock(stock, stock.klines.filter((item) => item.date <= date).slice(-90));
      if (scored) candidates.push(scored);
    }
    const recommendations = candidates.sort((a, b) => b.score - a.score).slice(0, 8);
    const confirmations = (await mapLimit(recommendations, 4, (item) => confirmCandidate(item, confirmDate))).filter(Boolean);
    const passed = confirmations.filter((item) => item.confirmPassed).sort((a, b) => b.confirmScore - a.confirmScore).slice(0, 2);

    console.log(`\n${date} 收盘观察池 -> ${confirmDate}`);
    console.log(`  热门板块：${hotSectors.map((item) => `TOP${item.rank}${item.name}(${formatPct(item.avgPct)},涨${percent(item.up, item.count)})`).join("；") || "无"}`);
    console.log(`  筛选数量：全样本${dayStocks.length}只，热门板块内${hotPoolCount}只，基础条件${fastPool.length}只，打分通过${recommendations.length}只`);
    if (!recommendations.length) {
      console.log("  观察池：无正式候选");
    } else {
      recommendations.forEach((item, index) => {
        console.log(`  ${index + 1}. ${item.name} ${item.code} ${item.score}${item.priority} ${item.industry} 收${formatNumber(item.price)} 涨${formatPct(item.pct)} 换${formatPct(item.turnover)} 额${formatNumber(item.amount / 100000000)}亿｜${item.reasons.join("；")}`);
      });
    }
    if (!passed.length) {
      console.log("  次日确认通过：无");
      confirmations.sort((a, b) => b.confirmScore - a.confirmScore).slice(0, 2).forEach((item) => {
        const blockers = item.confirmReasons.filter((reason) => /不足|跌破|未|不合格|低开|冲高|偏弱/.test(reason)).join("；");
        console.log(`    接近：${item.name} ${item.code} 确认${item.confirmScore}｜${blockers}`);
      });
    } else {
      console.log("  次日确认通过：");
      passed.forEach((item, index) => {
        console.log(`    ${index + 1}. ${item.name} ${item.code} 确认${item.confirmScore} 价${formatNumber(item.current.price)}｜${item.confirmReasons.join("；")}`);
      });
    }

    summaries.push({ date, confirmDate, hotSectors, recommendations, passed, confirmations });
  }

  const totalRecommendations = summaries.reduce((sum, item) => sum + item.recommendations.length, 0);
  const totalPassed = summaries.reduce((sum, item) => sum + item.passed.length, 0);
  console.log("\n汇总");
  console.log(`  观察池候选：${totalRecommendations} 只`);
  console.log(`  次日确认通过：${totalPassed} 只`);
  console.log("  注：10点分时和分钟MACD取不到时按页面规则不硬淘汰，但量比使用日线量比近似。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
