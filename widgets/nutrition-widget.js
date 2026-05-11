// =============================================================================
// Nutrition dashboard — Scriptable LARGE widget
//
// This file is fetched by your local bootstrap script on each widget refresh,
// so any change committed and deployed here lands on your phone automatically.
// The bootstrap declares API_URL and API_TOKEN before eval()ing this code.
// =============================================================================

const WIDGET_VERSION = "2.3.0";

// ---------- Theme ----------
const COLOR_BG = Color.dynamic(new Color("#ffffff"), new Color("#0f1115"));
const COLOR_FG = Color.dynamic(new Color("#1c1f24"), new Color("#f3f4f6"));
const COLOR_MUTED = Color.dynamic(new Color("#6b7280"), new Color("#9ca3af"));
const COLOR_TRACK = Color.dynamic(new Color("#e5e7eb"), new Color("#23272f"));
const COLOR_GREEN = new Color("#10b981");
const COLOR_RED = new Color("#ef4444");
const COLOR_BLUE = new Color("#3b82f6");
const COLOR_AMBER = new Color("#f59e0b");
const COLOR_VIOLET = new Color("#8b5cf6");

// ---------- Helpers ----------
function fmtNum(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(n).toLocaleString("en-US");
}
function fmtSigned(n) {
    if (n == null || isNaN(n)) return "—";
    const r = Math.round(n);
    return r > 0 ? `+${r.toLocaleString("en-US")}` : r.toLocaleString("en-US");
}
function fmtKg(n) {
    if (n == null || isNaN(n)) return "—";
    return `${n > 0 ? "+" : ""}${n.toFixed(1)}kg`;
}

async function fetchPayload() {
    const req = new Request(API_URL);
    req.headers = { Authorization: `Bearer ${API_TOKEN}` };
    req.timeoutInterval = 15;
    const json = await req.loadJSON();
    if (req.response.statusCode >= 400) {
        throw new Error(
            json?.error_description ?? json?.error ?? "request failed",
        );
    }
    return json;
}

// ---------- Components ----------
function addProgressBar(stack, fraction, color, width, height = 8) {
    const wrap = stack.addStack();
    wrap.cornerRadius = height / 2;
    wrap.backgroundColor = COLOR_TRACK;
    wrap.size = new Size(width, height);
    wrap.layoutHorizontally();

    const filled = wrap.addStack();
    filled.backgroundColor = color;
    filled.cornerRadius = height / 2;
    const cleaned = Math.max(0, Math.min(1, fraction ?? 0));
    filled.size = new Size(Math.max(2, width * cleaned), height);
}

function addMacroRow(stack, label, actual, target, color, barWidth) {
    const row = stack.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const lbl = row.addText(label);
    lbl.font = Font.mediumSystemFont(11);
    lbl.textColor = COLOR_MUTED;
    lbl.size = new Size(14, 0);

    row.addSpacer(4);

    const fraction = target ? actual / target : 0;
    addProgressBar(row, fraction, color, barWidth, 6);

    row.addSpacer(6);
    const val = row.addText(
        target != null
            ? `${Math.round(actual)}/${Math.round(target)}g`
            : `${Math.round(actual)}g`,
    );
    val.font = Font.systemFont(10);
    val.textColor = COLOR_FG;
}

// Render the weekly-minimum weight trend as a sparkline + dots image.
function buildWeightGraphImage(weeks, width, height) {
    const points = weeks
        .map((w, i) => ({ i, label: w.week_start, v: w.min_weight_kg }))
        .filter((p) => p.v != null);
    if (points.length < 2) return null;

    const ctx = new DrawContext();
    ctx.size = new Size(width, height);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    const padLeft = 28;
    const padRight = 6;
    const padTop = 8;
    const padBottom = 14;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const values = points.map((p) => p.v);
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const range = Math.max(0.3, maxV - minV);

    // Y-axis tick labels (min, max) — keeps the scale readable.
    ctx.setTextColor(new Color("#9ca3af"));
    ctx.setFont(Font.systemFont(9));
    ctx.drawTextInRect(
        `${maxV.toFixed(1)}`,
        new Rect(0, padTop - 4, padLeft - 4, 12),
    );
    ctx.drawTextInRect(
        `${minV.toFixed(1)}`,
        new Rect(0, padTop + plotH - 6, padLeft - 4, 12),
    );

    // Compute screen positions across the full graph (using all weeks, not
    // just the ones with data — keeps the time axis honest).
    const totalWeeks = weeks.length;
    const xFor = (i) =>
        padLeft + (i / Math.max(1, totalWeeks - 1)) * plotW;
    const yFor = (v) =>
        padTop + plotH - ((v - minV) / range) * plotH;

    // Line
    const path = new Path();
    let started = false;
    for (const p of points) {
        const x = xFor(p.i);
        const y = yFor(p.v);
        if (!started) {
            path.move(new Point(x, y));
            started = true;
        } else {
            path.addLine(new Point(x, y));
        }
    }
    ctx.setStrokeColor(COLOR_BLUE);
    ctx.setLineWidth(2);
    ctx.addPath(path);
    ctx.strokePath();

    // Dots — highlight the global low (best week) in green.
    const minPoint = points.reduce((best, p) => (p.v < best.v ? p : best), points[0]);
    for (const p of points) {
        const x = xFor(p.i);
        const y = yFor(p.v);
        const isBest = p === minPoint;
        ctx.setFillColor(isBest ? COLOR_GREEN : COLOR_BLUE);
        const r = isBest ? 4 : 3;
        ctx.fillEllipse(new Rect(x - r, y - r, r * 2, r * 2));
    }

    // X-axis: "8w" and "now" anchors
    ctx.setTextColor(new Color("#9ca3af"));
    ctx.setFont(Font.systemFont(9));
    ctx.drawTextInRect(
        `${totalWeeks}w ago`,
        new Rect(padLeft - 4, height - 12, 50, 12),
    );
    ctx.drawTextAlignedRight();
    ctx.drawTextInRect(
        "now",
        new Rect(width - padRight - 30, height - 12, 30, 12),
    );

    return ctx.getImage();
}

// ---------- Layout ----------
async function build() {
    const widget = new ListWidget();
    widget.backgroundColor = COLOR_BG;
    widget.setPadding(14, 16, 14, 16);
    widget.url =
        "scriptable:///run/" + encodeURIComponent(Script.name());
    widget.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);

    let data;
    try {
        data = await fetchPayload();
    } catch (err) {
        renderError(widget, err.message ?? String(err));
        return widget;
    }

    renderHeader(widget, data);
    widget.addSpacer(4);
    renderCalories(widget, data);
    widget.addSpacer(8);
    renderMacros(widget, data);
    widget.addSpacer(10);
    renderWeightGraph(widget, data);
    widget.addSpacer(8);
    renderFooter(widget, data);

    return widget;
}

function renderHeader(widget, data) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const title = row.addText("NUTRITION");
    title.font = Font.boldSystemFont(11);
    title.textColor = COLOR_MUTED;

    row.addSpacer(6);

    const datePart = row.addText("· " + data.today.date.slice(5));
    datePart.font = Font.systemFont(11);
    datePart.textColor = COLOR_MUTED;

    row.addSpacer();

    if (data.last_meal) {
        const last = row.addText("last meal " + data.last_meal.relative);
        last.font = Font.systemFont(10);
        last.textColor = COLOR_MUTED;
    } else {
        const empty = row.addText("no meals yet");
        empty.font = Font.systemFont(10);
        empty.textColor = COLOR_MUTED;
    }
}

function renderCalories(widget, data) {
    const t = data.today;
    const target = t.calories_out || (t.eer ?? 0);
    const fraction = target > 0 ? t.calories_in / target : 0;

    const bigRow = widget.addStack();
    bigRow.layoutHorizontally();
    bigRow.bottomAlignContent();

    const big = bigRow.addText(fmtNum(t.calories_in));
    big.font = Font.boldRoundedSystemFont(28);
    big.textColor = COLOR_FG;

    bigRow.addSpacer(4);

    const targetLbl = bigRow.addText(
        target > 0 ? `/ ${fmtNum(target)} kcal` : "kcal",
    );
    targetLbl.font = Font.systemFont(11);
    targetLbl.textColor = COLOR_MUTED;

    bigRow.addSpacer();

    if (target > 0) {
        const balText = bigRow.addText(
            t.balance < 0
                ? `${fmtSigned(t.balance)} deficit`
                : t.balance > 0
                  ? `${fmtSigned(t.balance)} surplus`
                  : "balanced",
        );
        balText.font = Font.semiboldSystemFont(12);
        balText.textColor = t.balance < 0 ? COLOR_GREEN : COLOR_RED;
    }

    widget.addSpacer(4);
    addProgressBar(widget, fraction, COLOR_BLUE, 328, 6);
}

function renderMacros(widget, data) {
    const m = data.today.macros;
    const targetsKnown = data.today.targets_known;

    const macros = widget.addStack();
    macros.layoutVertically();
    macros.spacing = 4;

    addMacroRow(
        macros,
        "P",
        m.protein_g.actual,
        targetsKnown ? m.protein_g.target_rda : null,
        COLOR_GREEN,
        260,
    );
    addMacroRow(
        macros,
        "C",
        m.carbs_g.actual,
        targetsKnown ? m.carbs_g.target_rda : null,
        COLOR_AMBER,
        260,
    );
    addMacroRow(
        macros,
        "F",
        m.fat_g.actual,
        targetsKnown
            ? (m.fat_g.target_min + m.fat_g.target_max) / 2
            : null,
        COLOR_VIOLET,
        260,
    );
}

function renderWeightGraph(widget, data) {
    const weeks = data.weight_graph?.weeks ?? [];

    const header = widget.addStack();
    header.layoutHorizontally();
    header.centerAlignContent();
    const t = header.addText("WEEKLY LOW · 8w");
    t.font = Font.boldSystemFont(10);
    t.textColor = COLOR_MUTED;
    header.addSpacer();

    const filled = weeks.filter((w) => w.min_weight_kg != null);
    if (filled.length >= 2) {
        const first = filled[0].min_weight_kg;
        const last = filled[filled.length - 1].min_weight_kg;
        const delta = last - first;
        const deltaText = header.addText(
            `${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg`,
        );
        deltaText.font = Font.semiboldSystemFont(10);
        deltaText.textColor = delta < 0 ? COLOR_GREEN : COLOR_RED;
    }

    widget.addSpacer(2);
    const img = buildWeightGraphImage(weeks, 326, 88);
    if (img) {
        widget.addImage(img);
    } else {
        const note = widget.addText(
            "Log at least 2 weeks of weight to see a trend.",
        );
        note.font = Font.systemFont(10);
        note.textColor = COLOR_MUTED;
    }
}

function renderFooter(widget, data) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const stepsLabel = row.addText("👟");
    stepsLabel.font = Font.systemFont(11);

    const stepsTxt = row.addText(
        ` ${fmtNum(data.today.steps)} steps (Health)`,
    );
    stepsTxt.font = Font.systemFont(10);
    stepsTxt.textColor = COLOR_FG;

    row.addSpacer();

    const adj = data.today.step_calories_adjusted;
    if (adj > 0) {
        const burnTxt = row.addText(`+${fmtNum(adj)} kcal burn`);
        burnTxt.font = Font.systemFont(10);
        burnTxt.textColor = COLOR_MUTED;
    }

    // Second footer row — week average + version stamp
    const row2 = widget.addStack();
    row2.layoutHorizontally();
    row2.centerAlignContent();

    const wkTxt = row2.addText(
        `week avg ${fmtSigned(data.week.avg_balance)} kcal/d`,
    );
    wkTxt.font = Font.systemFont(9);
    wkTxt.textColor = COLOR_MUTED;

    row2.addSpacer();

    const ts = row2.addText("↻ " + new Date().toLocaleTimeString());
    ts.font = Font.systemFont(9);
    ts.textColor = COLOR_MUTED;
}

function renderError(widget, message) {
    const title = widget.addText("Nutrition dashboard");
    title.font = Font.boldSystemFont(13);
    title.textColor = COLOR_FG;

    widget.addSpacer(6);

    const err = widget.addText("⚠ " + message);
    err.font = Font.systemFont(11);
    err.textColor = COLOR_RED;

    widget.addSpacer();

    if (typeof API_TOKEN === "undefined" || API_TOKEN === "PASTE_YOUR_TOKEN_HERE") {
        const hint = widget.addText(
            "Open https://nutrition-mcp-production-8ba9.up.railway.app/dashboard/setup to mint a token.",
        );
        hint.font = Font.systemFont(10);
        hint.textColor = COLOR_MUTED;
    }

    const ts = widget.addText("checked " + new Date().toLocaleTimeString());
    ts.font = Font.systemFont(9);
    ts.textColor = COLOR_MUTED;
}

// ---------- Entrypoint ----------
const widget = await build();
if (config.runsInWidget) {
    Script.setWidget(widget);
} else {
    widget.presentLarge();
}
Script.complete();
