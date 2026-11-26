/* Shared renderer for the MARKET part of the page. Used by the public page
   (site/index.html) and copied into the private Apps Script page. */
var LV_COLOR = ["var(--lv0)", "var(--lv1)", "var(--lv2)", "var(--lv3)", "var(--lv4)"];
var LV_NAME = ["正常", "注意", "警戒", "大跌", "回穩"];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function cls(x) { return x == null ? "flat" : x > 0 ? "up" : x < 0 ? "down" : "flat"; }
function pctTxt(x, d) {
  if (x == null) return "—";
  var v = (x * 100).toFixed(d == null ? 1 : d);
  return (x > 0 ? "+" : "") + v + "%";
}
function globalVal(g) {
  if (g.value == null) return '<span class="num flat">—</span>';
  if (g.unit === "pct") return '<span class="num ' + cls(g.week) + '">' + pctTxt(g.week) + "</span>";
  if (g.unit === "fx") return '<span class="num">' + g.value.toFixed(2) + "</span>";
  if (g.unit === "yield") return '<span class="num">' + g.value.toFixed(2) + "%</span>";
  return '<span class="num">' + g.value.toFixed(1) + "</span>";
}

function renderMarketState(m) {
  var s = m.state;
  return '<section><h2>市場狀態</h2>' +
    '<div class="state"><span class="dot" style="background:' + LV_COLOR[s.level] + '"></span>' +
    '<span class="label">' + esc(s.label) + "</span></div>" +
    '<ul class="lines">' + m.summary.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") +
    "</ul></section>";
}

function renderGlobal(m) {
  var rows = m.global.map(function (g) {
    var hint = g.unit === "pct" ? "本週" : "";
    return '<div class="row"><span class="k">' + esc(g.label) +
      (hint ? "<small>" + hint + "</small>" : "") + "</span>" + globalVal(g) + "</div>";
  }).join("");
  return "<section><h2>全球</h2>" + rows + "</section>";
}

function renderHoldingsWeek(m) {
  var max = 0.0001;
  m.holdings.forEach(function (h) { if (h.week != null) max = Math.max(max, Math.abs(h.week)); });
  function rows(cat) {
    return m.holdings.filter(function (h) { return h.category === cat; }).map(function (h) {
      var w = h.week == null ? 0 : Math.abs(h.week) / max * 50;
      var left = h.week != null && h.week < 0 ? 50 - w : 50;
      var color = h.week != null && h.week < 0 ? "var(--down)" : "var(--up)";
      return '<div class="bar-row"><span class="num">' + esc(h.code) + "</span>" +
        '<span class="num ' + cls(h.week) + '">' + pctTxt(h.week) + "</span>" +
        '<span class="bar"><i style="left:' + left + "%;width:" + w + "%;background:" + color + '"></i></span></div>';
    }).join("");
  }
  return "<section><h2>持股　本週</h2>" +
    '<div class="group">成長</div>' + rows("growth") +
    '<div class="group">高股息</div>' + rows("dividend") + "</section>";
}

function renderHistory(m) {
  var h = m.state_history || [];
  var dots = [];
  for (var i = h.length - 1; i >= 0 && dots.length < 26; i -= 5) dots.unshift(h[i]); // weekly
  return "<section><h2>近 6 個月</h2><div class=\"dots\">" +
    dots.map(function (d) {
      return '<span title="' + esc(d.date) + " " + LV_NAME[d.level] + '" style="background:' + LV_COLOR[d.level] + '"></span>';
    }).join("") + "</div>" +
    '<div class="legend">' + [0, 1, 2, 3, 4].map(function (l) {
      return '<b style="background:' + LV_COLOR[l] + '"></b>' + LV_NAME[l];
    }).join("") + "</div></section>";
}

function renderMeta(m) {
  var d = new Date(m.updated_at);
  var t = isNaN(d) ? m.as_of : d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return '<div class="meta">資料日 ' + esc(m.as_of) + "　更新 " + esc(t) + "</div>";
}
