const CUSTOM_WATCHLIST_KEY = "tw_etf_dashboard_custom_watchlist";
const PINNED_SECTOR_KEY = "tw_etf_dashboard_pinned_sector";
const SECTOR_TOP_N = 10; // how many of the sector pool to show each day, ranked by score
let trackedCodes = []; // codes already covered by the daily batch (config/etfs.json), filled in by renderDashboard
const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const INST_CATEGORIES = [
  "Foreign_Investor", "Foreign_Dealer_Self", "Investment_Trust", "Dealer_self", "Dealer_Hedging",
];

function fmtDate(iso) {
  if (!iso) return "";
  return iso.replace("T", " ").replace(/\+00:00$/, " UTC");
}

function scoreClass(label) {
  if (label === "偏多") return "bull";
  if (label === "偏空") return "bear";
  return "neutral";
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${path}`);
  return res.json();
}

function fmtLots(shares) {
  if (shares == null) return "-";
  const lots = Math.round(Math.abs(shares) / 1000);
  return lots.toLocaleString("zh-Hant", { maximumFractionDigits: 0 });
}

/** Arrow + unsigned magnitude, e.g. "▲ 1.42%" / "▼ 0.83%" instead of +/-. */
function fmtChange(value, opts = {}) {
  const { decimals = 2, suffix = "" } = opts;
  if (value == null) return "-";
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "";
  return `${arrow ? `<span class="arrow">${arrow}</span>` : ""}${Math.abs(value).toFixed(decimals)}${suffix}`;
}

function initInfoToggles() {
  document.querySelectorAll(".info-toggle:not([data-bound])").forEach(btn => {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.hidden = !target.hidden;
    });
  });
}

function initRefreshButton(onRefresh) {
  const btn = document.getElementById("refresh-btn");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.classList.add("spinning");
    try {
      await onRefresh();
    } finally {
      btn.disabled = false;
      btn.classList.remove("spinning");
    }
  });
}

// ---- Custom (user-added) watchlist: stored locally, fetched + scored live in the browser ----

function loadCustomCodes() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_WATCHLIST_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveCustomCodes(codes) {
  localStorage.setItem(CUSTOM_WATCHLIST_KEY, JSON.stringify(codes));
}

function removeCustomCode(code) {
  saveCustomCodes(loadCustomCodes().filter(c => c !== code));
  renderDashboard();
}

// ---- Pinned sector stocks: promotes a stock from the (rotating) sector pool
// into the stable "我的關注清單" section. Uses the data already fetched for the
// sector pool -- no extra network calls needed. ----

function loadPinnedCodes() {
  try {
    return JSON.parse(localStorage.getItem(PINNED_SECTOR_KEY) || "[]");
  } catch {
    return [];
  }
}

function savePinnedCodes(codes) {
  localStorage.setItem(PINNED_SECTOR_KEY, JSON.stringify(codes));
}

function pinSectorCode(code) {
  const codes = loadPinnedCodes();
  if (!codes.includes(code)) savePinnedCodes([...codes, code]);
  renderDashboard();
}

function unpinSectorCode(code) {
  savePinnedCodes(loadPinnedCodes().filter(c => c !== code));
  renderDashboard();
}

function finmindDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function finmindFetch(dataset, code, startDate) {
  const url = `${FINMIND_URL}?dataset=${encodeURIComponent(dataset)}&data_id=${encodeURIComponent(code)}&start_date=${startDate}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("網路連線失敗");
  const payload = await res.json();
  return payload.data || [];
}

async function lookupStockName(code) {
  const rows = await finmindFetch("TaiwanStockInfo", code, "2020-01-01").catch(() => []);
  return rows.length ? rows[0].stock_name : null;
}

/** Fetch + score a ticker entirely client-side (used for manually-added stocks
 * that aren't in the daily-batch tracked list). Mirrors scripts/fetch_data.py. */
async function fetchAndScoreTicker(code) {
  const startDate = finmindDateDaysAgo(240);
  const [priceRows, instRows] = await Promise.all([
    finmindFetch("TaiwanStockPrice", code, startDate),
    finmindFetch("TaiwanStockInstitutionalInvestorsBuySell", code, startDate).catch(() => []),
  ]);
  if (!priceRows.length) throw new Error("查無資料，請確認代號是否正確");
  priceRows.sort((a, b) => a.date.localeCompare(b.date));

  const instByDate = {};
  for (const r of instRows) {
    if (!INST_CATEGORIES.includes(r.name)) continue;
    const d = instByDate[r.date] || (instByDate[r.date] = { buy: 0, sell: 0 });
    d.buy += r.buy || 0;
    d.sell += r.sell || 0;
  }

  const dates = priceRows.map(r => r.date);
  const closes = priceRows.map(r => r.close);
  const volumes = priceRows.map(r => r.Trading_Volume);
  const ma5 = sma(closes, 5), ma20 = sma(closes, 20), ma60 = sma(closes, 60);
  const rsi14 = rsi(closes, 14);
  const { histogram } = macd(closes);

  const series = dates.map((date, i) => {
    const inst = instByDate[date];
    return {
      date, close: closes[i], volume: volumes[i],
      ma5: ma5[i], ma20: ma20[i], ma60: ma60[i], rsi14: rsi14[i], hist: histogram[i],
      inst_buy: inst ? inst.buy : null,
      inst_sell: inst ? inst.sell : null,
      inst_net: inst ? inst.buy - inst.sell : null,
    };
  });

  const today = series[series.length - 1];
  const yesterday = series[series.length - 2];
  const score = yesterday ? computeScore({
    ma5: today.ma5, ma20: today.ma20, ma60: today.ma60,
    hist: today.hist, prevHist: yesterday.hist,
    close: today.close, prevClose: yesterday.close,
    instNet: today.inst_net, rsiValue: today.rsi14,
  }) : null;

  const name = (await lookupStockName(code).catch(() => null)) || code;

  return {
    code, name, series,
    summaryItem: {
      code, name, date: today.date, close: today.close,
      change: yesterday ? today.close - yesterday.close : null,
      volume: today.volume,
      inst_buy: today.inst_buy, inst_sell: today.inst_sell, inst_net: today.inst_net,
      score, custom: true,
    },
  };
}

async function loadCustomSummaryItems() {
  const codes = loadCustomCodes();
  const results = await Promise.all(codes.map(code =>
    fetchAndScoreTicker(code)
      .then(r => r.summaryItem)
      .catch(err => ({ code, name: code, error: err.message, custom: true }))
  ));
  return results;
}

function initAddToggle() {
  const toggleBtn = document.getElementById("add-toggle-btn");
  const form = document.getElementById("add-form");
  if (!toggleBtn || !form || toggleBtn.dataset.bound) return;
  toggleBtn.dataset.bound = "1";
  toggleBtn.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) document.getElementById("add-input").focus();
  });
}

function initAddForm() {
  const form = document.getElementById("add-form");
  if (!form || form.dataset.bound) return;
  form.dataset.bound = "1";
  const input = document.getElementById("add-input");
  const button = document.getElementById("add-button");
  const msg = document.getElementById("add-form-msg");

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (!code) return;

    const existing = loadCustomCodes();
    if (existing.includes(code) || trackedCodes.includes(code)) {
      msg.textContent = "已經在清單裡了";
      return;
    }

    button.disabled = true;
    msg.textContent = "查詢中...";
    try {
      const result = await fetchAndScoreTicker(code);
      saveCustomCodes([...existing, code]);
      msg.textContent = `已新增 ${result.name} (${code})`;
      input.value = "";
      renderDashboard();
    } catch (err) {
      msg.textContent = err.message || "新增失敗，請確認代號是否正確";
    } finally {
      button.disabled = false;
    }
  });
}

// ---- Market overview strip ----

async function renderMarketPanel() {
  const el = document.getElementById("market-panel");
  if (!el) return;
  try {
    const data = await fetchJSON("data/market.json");
    const taiex = data.taiex;
    if (!taiex) {
      el.innerHTML = '<div class="empty">目前沒有大盤資料</div>';
      return;
    }
    const cls = taiex.change_pct > 0 ? "up" : taiex.change_pct < 0 ? "down" : "";
    const pctText = fmtChange(taiex.change_pct, { suffix: "%" });
    const weekHtml = taiex.week.map(d => {
      const dCls = d.change_pct > 0 ? "up" : d.change_pct < 0 ? "down" : "";
      const dText = fmtChange(d.change_pct, { decimals: 1, suffix: "%" });
      return `<div class="day"><div>${d.date.slice(5)}</div><div class="pct ${dCls}">${dText}</div></div>`;
    }).join("");
    el.innerHTML = `
      <div class="market-strip">
        <div class="market-main">
          <span class="market-close">${taiex.close.toLocaleString("zh-Hant")}</span>
          <span class="change ${cls}">${pctText}</span>
        </div>
        <div class="market-week">${weekHtml}</div>
      </div>
    `;

    if (taiex.history && taiex.history.length && document.getElementById("marketChart")) {
      createChart("marketChart", {
        type: "line",
        data: {
          labels: taiex.history.map(p => p.date),
          datasets: [buildDataset(taiex.history, "close", "加權指數", "#000000")],
        },
        options: chartOptions(),
      });
    }
  } catch (err) {
    el.innerHTML = '<div class="empty">大盤資料載入失敗</div>';
  }
}

// ---- Dashboard (index.html) ----

function renderInstRow(item) {
  if (item.inst_buy == null || item.inst_sell == null) {
    return '<div class="inst-row">大戶買賣：無資料</div>';
  }
  const net = item.inst_net || 0;
  const netCls = net > 0 ? "up" : net < 0 ? "down" : "";
  const netText = net > 0 ? `淨買超 ${fmtLots(net)} 張` : net < 0 ? `淨賣超 ${fmtLots(net)} 張` : "買賣平衡";
  return `
    <div class="inst-row">
      大戶：買 ${fmtLots(item.inst_buy)} 張 / 賣 ${fmtLots(item.inst_sell)} 張
      <span class="change ${netCls}">（${netText}）</span>
    </div>
  `;
}

function renderWatchlist(items) {
  const panel = document.getElementById("watchlist-panel");
  if (!panel) return;
  const bullish = items
    .filter(item => item.score && item.score.label === "偏多")
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, 10);

  if (!bullish.length) {
    panel.innerHTML = '<div class="empty">今天沒有標的達到「偏多」，建議先觀望。</div>';
    return;
  }

  panel.innerHTML = `<ul class="watchlist">${bullish.map(item => `
    <li>
      <a href="etf.html?code=${encodeURIComponent(item.code)}">
        <span class="badge bull">${item.score.total}</span>
        <strong>${item.name} (${item.code})</strong>
      </a>
      <div class="watchlist-reason">${item.score.breakdown.map(b => b.reason).join("；")}</div>
    </li>
  `).join("")}</ul>`;
}

function renderCard(item) {
  if (item.error) {
    return `
      <div class="card custom">
        <button class="remove-btn" onclick="removeCustomCode('${item.code}')">×</button>
        <div class="code">${item.code}</div>
        <div class="empty" style="padding: 8px 0; text-align: left;">載入失敗：${item.error}</div>
      </div>
    `;
  }
  const score = item.score;
  const label = score ? score.label : "無資料";
  const cls = scoreClass(label);
  const change = item.change;
  const changeCls = change > 0 ? "up" : change < 0 ? "down" : "";
  const changeText = fmtChange(change);

  let cornerBtn = "";
  if (item.custom) {
    cornerBtn = `<button class="remove-btn" onclick="removeCustomCode('${item.code}')" title="移除">×</button>`;
  } else if (item.pinned) {
    cornerBtn = `<button class="remove-btn" onclick="unpinSectorCode('${item.code}')" title="從關注清單移除（仍會留在產業觀察清單）">×</button>`;
  }

  return `
    <a class="card${item.custom || item.pinned ? " custom" : ""}" href="etf.html?code=${encodeURIComponent(item.code)}">
      ${cornerBtn}
      <div class="code">${item.code}</div>
      <div class="name">${item.name}</div>
      <div class="price-row">
        <span class="close">${item.close}</span>
        <span class="change ${changeCls}">${changeText}</span>
      </div>
      <div class="volume-row">當天成交量：${fmtLots(item.volume)} 張</div>
      ${renderInstRow(item)}
      <span class="badge ${cls}">${label} ${score ? `(${score.total})` : ""}</span>
    </a>
  `;
}

function renderSectorCard(item) {
  const score = item.score;
  const label = score ? score.label : "無資料";
  const cls = scoreClass(label);
  const change = item.change;
  const changeCls = change > 0 ? "up" : change < 0 ? "down" : "";
  const changeText = fmtChange(change);
  const pinBtn = item.pinned
    ? `<span class="pin-btn pinned" title="已加入我的關注清單">✓ 已加入</span>`
    : `<button class="pin-btn" onclick="event.preventDefault(); pinSectorCode('${item.code}')">＋ 加入關注</button>`;

  return `
    <a class="card" href="etf.html?code=${encodeURIComponent(item.code)}">
      <div class="code">${item.code}</div>
      <div class="name">${item.name}</div>
      <div class="price-row">
        <span class="close">${item.close}</span>
        <span class="change ${changeCls}">${changeText}</span>
      </div>
      <div class="volume-row">當天成交量：${fmtLots(item.volume)} 張</div>
      ${renderInstRow(item)}
      <span class="badge ${cls}">${label} ${score ? `(${score.total})` : ""}</span>
      <div class="pin-row">${pinBtn}</div>
    </a>
  `;
}

async function renderDashboard() {
  const grid = document.getElementById("grid");
  const sectorGrid = document.getElementById("sector-grid");
  const updatedEl = document.getElementById("updated");
  initInfoToggles();
  initAddToggle();
  initAddForm();
  initRefreshButton(() => renderDashboard());
  renderMarketPanel();

  try {
    const [summary, customItems] = await Promise.all([
      fetchJSON("data/summary.json"),
      loadCustomSummaryItems(),
    ]);
    updatedEl.textContent = `最後更新：${fmtDate(summary.updated_at)}`;
    trackedCodes = summary.items.map(i => i.code);

    const watchlistItems = summary.items.filter(i => i.group === "watchlist");
    const sectorItems = summary.items.filter(i => i.group === "sector");
    const pinnedCodes = loadPinnedCodes();

    const allItems = [...summary.items, ...customItems];
    if (!allItems.length) {
      grid.innerHTML = '<div class="empty">目前沒有資料</div>';
      return;
    }

    renderWatchlist(allItems.filter(i => !i.error));

    const myWatchlist = [
      ...watchlistItems,
      ...sectorItems.filter(i => pinnedCodes.includes(i.code)).map(i => ({ ...i, pinned: true })),
      ...customItems.map(i => ({ ...i, custom: true })),
    ];
    grid.innerHTML = myWatchlist.map(renderCard).join("");

    if (sectorGrid) {
      const sectorRanked = sectorItems
        .slice()
        .sort((a, b) => (b.score ? b.score.total : -Infinity) - (a.score ? a.score.total : -Infinity))
        .slice(0, SECTOR_TOP_N)
        .map(i => ({ ...i, pinned: pinnedCodes.includes(i.code) }));
      sectorGrid.innerHTML = sectorRanked.length
        ? sectorRanked.map(renderSectorCard).join("")
        : '<div class="empty">目前沒有產業觀察資料</div>';
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty">資料載入失敗：${err.message}</div>`;
  }
}

// ---- Detail page (etf.html) ----

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

const chartInstances = {};

function createChart(canvasId, config) {
  if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
  chartInstances[canvasId] = new Chart(document.getElementById(canvasId), config);
}

function buildDataset(series, key, label, color) {
  return {
    label,
    data: series.map(p => p[key]),
    borderColor: color,
    borderWidth: 2.5,
    pointRadius: 0,
    spanGaps: true,
  };
}

async function loadTickerDetail(code) {
  try {
    return await fetchJSON(`data/${code}.json`);
  } catch {
    const result = await fetchAndScoreTicker(code);
    return { code: result.code, name: result.name, series: result.series, score: result.summaryItem.score };
  }
}

async function renderDetail() {
  const code = getQueryParam("code");
  const titleEl = document.getElementById("title");
  const updatedEl = document.getElementById("updated");
  const scorePanel = document.getElementById("score-panel");
  initInfoToggles();
  initRefreshButton(() => renderDetail());

  if (!code) {
    titleEl.textContent = "找不到代號";
    return;
  }

  try {
    const detail = await loadTickerDetail(code);
    const series = detail.series;
    const labels = series.map(p => p.date);
    titleEl.textContent = `${detail.name} (${detail.code || code})`;

    let score = detail.score;
    if (score === undefined) {
      const summary = await fetchJSON("data/summary.json").catch(() => null);
      const item = summary && summary.items.find(i => i.code === code);
      score = item ? item.score : null;
      updatedEl.textContent = summary ? `最後更新：${fmtDate(summary.updated_at)}` : "";
    } else {
      updatedEl.textContent = "即時計算（手動新增的股票，資料來自瀏覽器即時查詢）";
    }
    renderScorePanel(scorePanel, score);
    renderChartAnalyses(series, score);

    createChart("priceChart", {
      type: "line",
      data: {
        labels,
        datasets: [
          buildDataset(series, "close", "收盤價", "#000000"),
          buildDataset(series, "ma5", "MA5", "#4d7fff"),
          buildDataset(series, "ma20", "MA20", "#16a34a"),
          buildDataset(series, "ma60", "MA60", "#ff7ad9"),
        ],
      },
      options: chartOptions(),
    });

    createChart("rsiChart", {
      type: "line",
      data: {
        labels,
        datasets: [buildDataset(series, "rsi14", "RSI", "#4d7fff")],
      },
      options: chartOptions({ min: 0, max: 100 }),
    });

    createChart("macdChart", {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "MACD 柱狀圖",
          data: series.map(p => p.hist),
          backgroundColor: series.map(p => (p.hist >= 0 ? "#ff3b30" : "#16a34a")),
        }],
      },
      options: chartOptions(),
    });

    createChart("instChart", {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "大戶買賣超（張）",
          data: series.map(p => (p.inst_net != null ? p.inst_net / 1000 : null)),
          backgroundColor: series.map(p => (p.inst_net >= 0 ? "#ff3b30" : "#16a34a")),
        }],
      },
      options: chartOptions(),
    });
  } catch (err) {
    titleEl.textContent = "資料載入失敗";
    scorePanel.textContent = err.message;
  }
}

function chartOptions(yRange = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { maxTicksLimit: 8, color: "#000000", font: { weight: 600 } }, grid: { display: false } },
      y: { ...yRange, ticks: { color: "#000000", font: { weight: 600 } }, grid: { color: "rgba(0,0,0,0.12)" } },
    },
    plugins: { legend: { labels: { boxWidth: 12, color: "#000000", font: { weight: 600 } } } },
  };
}

function rsiAnalysisText(rsiValue) {
  if (rsiValue == null) return "目前沒有 RSI 資料。";
  const v = rsiValue.toFixed(0);
  if (rsiValue >= 70) return `今天 RSI 是 ${v}，偏高，可能買氣過熱，留意回檔。`;
  if (rsiValue <= 30) return `今天 RSI 是 ${v}，偏低，可能賣壓過重，留意反彈。`;
  return `今天 RSI 是 ${v}，普通，沒有過熱或超賣訊號。`;
}

/** Fills in each chart panel's visible caption with today's actual reading
 * (reusing the score breakdown reasons for price/MACD/大戶買賣), instead of
 * only the static "what is this indicator" text (that's now behind the i icon). */
function renderChartAnalyses(series, score) {
  const today = series[series.length - 1];
  const priceEl = document.getElementById("price-analysis");
  const rsiEl = document.getElementById("rsi-analysis");
  const macdEl = document.getElementById("macd-analysis");
  const instEl = document.getElementById("inst-analysis");

  const findFactor = prefix => score && score.breakdown.find(b => b.factor.startsWith(prefix));
  const trend = findFactor("趨勢");
  const momentum = findFactor("動能");
  const chip = findFactor("籌碼");

  if (priceEl) priceEl.textContent = trend ? `今天分析：${trend.reason}。` : "目前沒有足夠資料分析趨勢。";
  if (rsiEl) rsiEl.textContent = `今天分析：${rsiAnalysisText(today ? today.rsi14 : null)}`;
  if (macdEl) macdEl.textContent = momentum ? `今天分析：${momentum.reason}。` : "目前沒有足夠資料分析動能。";
  if (instEl) instEl.textContent = chip ? `今天分析：${chip.reason}。` : "目前沒有足夠資料分析籌碼。";
}

/** Builds a per-stock plain-language summary from the actual score + breakdown,
 * instead of one fixed sentence per label (so "中性 20" and "中性 -25" read differently). */
function describeScore(score) {
  const total = score.total;
  let lean;
  if (total >= 60) lean = "訊號強烈偏多";
  else if (total >= 30) lean = "偏多";
  else if (total >= 10) lean = "稍微偏多，但還沒到偏多的門檻（30分）";
  else if (total > -10) lean = "多空力量差不多，方向不明顯";
  else if (total > -30) lean = "稍微偏空，但還沒到偏空的門檻（-30分）";
  else if (total > -60) lean = "偏空";
  else lean = "訊號強烈偏空";

  const dominant = score.breakdown.reduce(
    (a, b) => (Math.abs(b.score) > Math.abs(a.score) ? b : a)
  );
  const dominantText = dominant.score !== 0
    ? `目前影響最大的是「${dominant.factor}」：${dominant.reason}。`
    : "";

  return `白話說：綜合分數 ${total} 分，${lean}。${dominantText}不保證之後真的會照這個方向走。`;
}

function renderScorePanel(panel, score) {
  if (!score) {
    panel.innerHTML = '<div class="empty">尚無評分資料</div>';
    return;
  }
  const cls = scoreClass(score.label);
  const plain = describeScore(score);
  panel.innerHTML = `
    <div class="badge ${cls}">${score.label}</div>
    <div class="score-total">${score.total}</div>
    <p class="chart-caption">${plain}</p>
    ${score.breakdown.map(b => `
      <div class="breakdown-row">
        <span class="factor">${b.factor} (${b.score >= 0 ? "+" : ""}${b.score})</span>
        <span class="reason">${b.reason}</span>
      </div>
    `).join("")}
    ${score.caution ? `<div class="caution">${score.caution}</div>` : ""}
  `;
}
