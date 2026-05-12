// =============================================================================
// Nutrition dashboard — Scriptable LARGE widget
//
// This file is fetched by your local bootstrap script on each widget refresh,
// so any change committed and deployed here lands on your phone automatically.
// The bootstrap declares API_URL and API_TOKEN before eval()ing this code.
// =============================================================================

const WIDGET_VERSION = "4.1.0";

// Weight targets shown in the forecast section. Kept here so the widget can
// label them even when the backend payload changes shape.
const FORECAST_GOALS = [115, 110];

// ---------- Theme ----------
// "Wealth dashboard" — warm off-white background, deep matte foreground,
// one accent. Adapts to light/dark mode so it sits well on either home
// screen wallpaper.
const COLOR_BG = Color.dynamic(
    new Color("#fafaf7"), // warm cream
    new Color("#0a0a0a"), // matte black
);
const COLOR_SURFACE = Color.dynamic(
    new Color("#f3f1ec"),
    new Color("#161616"),
);
const COLOR_FG = Color.dynamic(
    new Color("#0a0a0a"),
    new Color("#fafaf7"),
);
const COLOR_MUTED = Color.dynamic(
    new Color("#6b6963"),
    new Color("#a1a09a"),
);
const COLOR_FAINT = Color.dynamic(
    new Color("#a8a59d"),
    new Color("#54524d"),
);
const COLOR_HAIRLINE = Color.dynamic(
    new Color("#e5e1d8"),
    new Color("#232220"),
);

const COLOR_TRACK = Color.dynamic(
    new Color("#e9e6dd"),
    new Color("#1f1e1c"),
);

// Single accent — deep emerald. Used sparingly: section bullet, progress fill,
// best-week dot on weight graph, deficit text.
const COLOR_ACCENT = Color.dynamic(
    new Color("#0b5234"),
    new Color("#3ea679"),
);
// Warning color, used only for surplus / over-target states.
const COLOR_WARNING = Color.dynamic(
    new Color("#a23a2b"),
    new Color("#e07a5b"),
);

// Kept under their old names so existing graph code keeps compiling.
const COLOR_GREEN = COLOR_ACCENT;
const COLOR_RED = COLOR_WARNING;
const COLOR_BLUE = COLOR_FG;
const COLOR_AMBER = COLOR_MUTED;
const COLOR_VIOLET = COLOR_MUTED;
const COLOR_CYAN = COLOR_ACCENT;
const COLOR_BORDER = COLOR_HAIRLINE;

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
function fmtShortDate(iso) {
    // "2026-05-11" -> "May 11"
    if (!iso) return "—";
    const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
    const m = d.toLocaleString("en-US", { month: "short" });
    return `${m} ${String(d.getDate()).padStart(2, "0")}`;
}
function fmtWeekday(iso) {
    if (!iso) return "";
    const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
    return d.toLocaleString("en-US", { weekday: "short" });
}

// `selectedDate` (YYYY-MM-DD) tells the backend which day to surface in the
// `today` block. Falls back to real today if not provided.
async function fetchPayload(selectedDate) {
    const url = selectedDate
        ? `${API_URL}?date=${encodeURIComponent(selectedDate)}`
        : API_URL;
    const req = new Request(url);
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

// Path used to persist the user's day-strip selection across tap → app-open →
// next widget refresh. Auto-expires after 24h so the widget eventually
// reverts to today without manual reset.
function selectionStatePath() {
    const fm = FileManager.local();
    return fm.joinPath(fm.documentsDirectory(), "_nutrition-widget-selection.json");
}

function readPersistedSelection() {
    const fm = FileManager.local();
    const path = selectionStatePath();
    if (!fm.fileExists(path)) return null;
    try {
        const raw = JSON.parse(fm.readString(path));
        if (!raw?.date || typeof raw.date !== "string") return null;
        const savedAt = Number(raw.savedAt) || 0;
        if (Date.now() - savedAt > 24 * 60 * 60 * 1000) return null;
        return raw.date;
    } catch {
        return null;
    }
}

function writePersistedSelection(date) {
    const fm = FileManager.local();
    fm.writeString(
        selectionStatePath(),
        JSON.stringify({ date, savedAt: Date.now() }),
    );
}

function clearPersistedSelection() {
    const fm = FileManager.local();
    const path = selectionStatePath();
    if (fm.fileExists(path)) fm.remove(path);
}

// Read the ?date= query param that gets passed when the user taps a day cell.
function readSelectedDateFromArgs() {
    try {
        const params = args?.queryParameters ?? {};
        const d = params.date;
        if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    } catch {
        // args is undefined when running the script standalone
    }
    return null;
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
    lbl.font = Font.semiboldSystemFont(10);
    lbl.textColor = COLOR_MUTED;
    lbl.size = new Size(14, 0);

    row.addSpacer(6);

    const fraction = target ? actual / target : 0;
    addProgressBar(row, fraction, COLOR_FG, barWidth, 2);

    row.addSpacer(10);
    const val = row.addText(
        target != null
            ? `${Math.round(actual)} / ${Math.round(target)}g`
            : `${Math.round(actual)}g`,
    );
    val.font = Font.regularSystemFont(10);
    val.textColor = COLOR_FG;
}

// Pick a "nice" step (1, 2, 5, 10, ...) that produces 3-5 ticks across the
// given value range. Used to render Y-axis labels at round numbers.
function pickNiceStep(range, targetTicks) {
    if (range <= 0) return 1;
    const rough = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if (norm < 1.5) step = 1;
    else if (norm < 3) step = 2;
    else if (norm < 7) step = 5;
    else step = 10;
    return step * mag;
}

// Weekly-minimum weight trend as a full chart: line + dots, Y-axis tick
// labels (kg), X-axis date labels, and a horizontal target line per goal.
function buildWeightGraphImage(weeks, targets, width, height) {
    const points = weeks
        .map((w, i) => ({ i, label: w.week_start, v: w.min_weight_kg }))
        .filter((p) => p.v != null);
    if (points.length < 2) return null;

    const ctx = new DrawContext();
    ctx.size = new Size(width, height);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    const padLeft = 34;
    const padRight = 8;
    const padTop = 6;
    const padBottom = 16;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    // Y-range: include weight points AND any target lines that fall close
    // enough to the data range so the goal line is visible on the chart.
    const dataValues = points.map((p) => p.v);
    let lo = Math.min(...dataValues);
    let hi = Math.max(...dataValues);
    if (targets && targets.length) {
        for (const t of targets) {
            // Only pull the axis to a target if it's within ~5kg of the
            // existing data — keeps the chart from collapsing when a target
            // is far away.
            if (t < lo && lo - t < 5) lo = t;
            if (t > hi && t - hi < 5) hi = t;
        }
    }
    // Pad the range slightly so dots aren't flush against the top/bottom.
    const span = Math.max(0.5, hi - lo);
    const pad = span * 0.12;
    const minV = lo - pad;
    const maxV = hi + pad;
    const range = maxV - minV;

    const totalWeeks = weeks.length;
    const xFor = (i) =>
        padLeft + (i / Math.max(1, totalWeeks - 1)) * plotW;
    const yFor = (v) => padTop + plotH - ((v - minV) / range) * plotH;

    // --- Y-axis tick labels (no grid lines — clean) ---
    const step = pickNiceStep(range, 3);
    const firstTick = Math.ceil(minV / step) * step;
    // Use direct hex matched to the warm-cream palette. Dark mode adjusts
    // via the SystemAppearance flag the caller sets in the graph wrapper.
    const isDark = !!(Device.isUsingDarkAppearance && Device.isUsingDarkAppearance());
    const axisLabelColor = isDark
        ? new Color("#54524d")
        : new Color("#a8a59d");
    const lineColor = isDark
        ? new Color("#fafaf7", 0.92)
        : new Color("#0a0a0a", 0.95);
    const dotColor = lineColor;
    const accentColor = isDark
        ? new Color("#3ea679")
        : new Color("#0b5234");
    const hairlineColor = isDark
        ? new Color("#232220")
        : new Color("#e5e1d8");

    ctx.setTextColor(axisLabelColor);
    ctx.setFont(Font.regularSystemFont(9));
    ctx.setTextAlignedRight();
    for (let v = firstTick; v <= maxV; v += step) {
        const y = yFor(v);
        ctx.drawTextInRect(
            v.toFixed(0),
            new Rect(0, y - 6, padLeft - 6, 12),
        );
    }

    // --- Target lines (dotted hairlines, paired with quiet labels) ---
    if (targets && targets.length) {
        for (const t of targets) {
            if (t < minV || t > maxV) continue;
            const y = yFor(t);
            ctx.setStrokeColor(hairlineColor);
            ctx.setLineWidth(0.6);
            const segLen = 3;
            const gap = 4;
            for (let x = padLeft; x < width - padRight; x += segLen + gap) {
                const p = new Path();
                p.move(new Point(x, y));
                p.addLine(
                    new Point(Math.min(x + segLen, width - padRight), y),
                );
                ctx.addPath(p);
                ctx.strokePath();
            }
            ctx.setTextColor(axisLabelColor);
            ctx.setFont(Font.regularSystemFont(9));
            ctx.setTextAlignedRight();
            ctx.drawTextInRect(
                `${t}`,
                new Rect(width - padRight - 28, y - 11, 26, 10),
            );
        }
    }

    // --- Weight line — thin, deep, restrained ---
    const linePath = new Path();
    let started = false;
    for (const p of points) {
        const x = xFor(p.i);
        const y = yFor(p.v);
        if (!started) {
            linePath.move(new Point(x, y));
            started = true;
        } else {
            linePath.addLine(new Point(x, y));
        }
    }
    ctx.setStrokeColor(lineColor);
    ctx.setLineWidth(1.4);
    ctx.addPath(linePath);
    ctx.strokePath();

    // --- Dots — best week subtly highlighted in accent emerald ---
    const minPoint = points.reduce(
        (best, p) => (p.v < best.v ? p : best),
        points[0],
    );
    for (const p of points) {
        const x = xFor(p.i);
        const y = yFor(p.v);
        const isBest = p === minPoint;
        ctx.setFillColor(isBest ? accentColor : dotColor);
        const r = isBest ? 3.5 : 2;
        ctx.fillEllipse(new Rect(x - r, y - r, r * 2, r * 2));
    }

    // --- X-axis date labels (3 anchors: first, middle, last week) ---
    ctx.setTextColor(axisLabelColor);
    ctx.setFont(Font.regularSystemFont(9));
    const labelIndices = [
        0,
        Math.floor((totalWeeks - 1) / 2),
        totalWeeks - 1,
    ];
    for (let li = 0; li < labelIndices.length; li++) {
        const idx = labelIndices[li];
        const w = weeks[idx];
        if (!w) continue;
        const x = xFor(idx);
        const text = fmtShortDate(w.week_start);
        const labelW = 50;
        // Edge anchoring: align first label left, last label right, middle center.
        if (li === 0) {
            ctx.setTextAlignedLeft();
            ctx.drawTextInRect(
                text,
                new Rect(x - 4, height - 12, labelW, 12),
            );
        } else if (li === labelIndices.length - 1) {
            ctx.setTextAlignedRight();
            ctx.drawTextInRect(
                text,
                new Rect(x - labelW + 4, height - 12, labelW, 12),
            );
        } else {
            ctx.setTextAlignedCenter();
            ctx.drawTextInRect(
                text,
                new Rect(x - labelW / 2, height - 12, labelW, 12),
            );
        }
    }

    return ctx.getImage();
}

// ---------- Layout ----------
// Inserts inter-character spaces so "FORECAST" reads as "F O R E C A S T".
// Hack for letter-spacing since Scriptable's Font API doesn't expose tracking.
function spaceCaps(s) {
    return s.toUpperCase().split("").join(" ");
}

function addDivider(widget) {
    const d = widget.addStack();
    d.backgroundColor = COLOR_BORDER;
    d.size = new Size(0, 1);
}

// Section label — quiet small caps in muted gray, optional muted suffix
// on the right. No bullets, no glyphs.
function addSectionLabel(widget, label, suffix) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const t = row.addText(spaceCaps(label));
    t.font = Font.semiboldSystemFont(9);
    t.textColor = COLOR_MUTED;

    if (suffix) {
        row.addSpacer();
        const s = row.addText(suffix);
        s.font = Font.regularSystemFont(10);
        s.textColor = COLOR_MUTED;
    }
}

// Numbers use proportional system fonts at appropriate weight — proportional
// reads more refined than mono for this aesthetic. Kept the `monoFont` name
// for backward compat in the file but it now returns a tabular-feeling weight.
function monoFont(size, weight) {
    if (weight === "bold") return Font.semiboldSystemFont(size);
    return Font.regularSystemFont(size);
}
function heroFont(size) {
    // Slightly tighter hero number — system "thin"-to-"bold" range. Bold
    // semicondensed reads like the figures on a Mercury / Stripe statement.
    return Font.boldSystemFont(size);
}

async function build() {
    const widget = new ListWidget();
    widget.backgroundColor = COLOR_BG;
    widget.setPadding(16, 18, 14, 18);
    // Default tap (anywhere not over a day cell) clears the persisted
    // selection and exits silently — Scriptable barely flashes.
    widget.url =
        "scriptable:///run/" +
        encodeURIComponent(Script.name()) +
        "?reset=1";
    // Hint iOS to refresh shortly when we've persisted a new selection so the
    // day strip's pick shows up sooner. Apple still controls actual timing.
    widget.refreshAfterDate = new Date(Date.now() + 2 * 60 * 1000);

    // Selection priority: explicit URL arg (just tapped a day) > persisted
    // pick (recent tap) > nothing (show today).
    const argDate = readSelectedDateFromArgs();
    const persistedDate = readPersistedSelection();
    const selectedDate = argDate ?? persistedDate ?? null;

    let data;
    try {
        data = await fetchPayload(selectedDate);
    } catch (err) {
        renderError(widget, err.message ?? String(err));
        return widget;
    }

    renderHeader(widget, data);
    if (data.insight?.text) {
        widget.addSpacer(4);
        renderInsight(widget, data);
    }
    widget.addSpacer(6);
    renderCalories(widget, data);
    widget.addSpacer(8);
    renderMacros(widget, data);

    widget.addSpacer(8);
    addDivider(widget);
    widget.addSpacer(6);
    renderForecast(widget, data);

    widget.addSpacer(8);
    addDivider(widget);
    widget.addSpacer(4);
    renderWeightGraph(widget, data);

    widget.addSpacer(6);
    renderDayStrip(widget, data);
    widget.addSpacer(4);
    renderFooter(widget, data);

    return widget;
}

function renderInsight(widget, data) {
    // Quiet inline callout — italic-ish refined sans, restrained to a single
    // line. No card, no left bar, no emoji.
    const text = widget.addText(data.insight.text);
    text.font = Font.regularSystemFont(11);
    text.textColor = COLOR_MUTED;
    text.lineLimit = 2;
}

function renderDayStrip(widget, data) {
    const cells = data.week_strip ?? [];
    if (cells.length === 0) return;

    const eer = data.today?.eer ?? null;

    const strip = widget.addStack();
    strip.layoutHorizontally();
    strip.spacing = 6;

    for (const c of cells) {
        const cell = strip.addStack();
        cell.layoutVertically();
        cell.centerAlignContent();
        cell.spacing = 2;
        cell.setPadding(6, 0, 6, 0);
        cell.size = new Size(40, 44);

        // Restrained selection state — no neon, just a subtle filled surface
        // for the selected day. Hairline underline for today.
        if (c.is_selected) {
            cell.backgroundColor = COLOR_SURFACE;
            cell.cornerRadius = 6;
        }

        cell.url =
            "scriptable:///run/" +
            encodeURIComponent(Script.name()) +
            "?date=" +
            encodeURIComponent(c.date);

        const dayLetter = cell.addText(c.weekday_short);
        dayLetter.font = Font.semiboldSystemFont(9);
        dayLetter.textColor = c.is_today ? COLOR_FG : COLOR_MUTED;

        const kcal = cell.addText(
            c.calories_in > 0 ? fmtNum(c.calories_in) : "—",
        );
        kcal.font = c.is_selected
            ? Font.semiboldSystemFont(11)
            : Font.regularSystemFont(11);
        kcal.textColor = c.calories_in > 0 ? COLOR_FG : COLOR_FAINT;

        // Tiny dot under today's cell for orientation. Color encodes balance.
        if (c.balance != null && eer != null && c.calories_in > 0) {
            const dot = cell.addStack();
            dot.backgroundColor =
                c.balance < 0 ? COLOR_ACCENT : COLOR_WARNING;
            dot.size = new Size(4, 4);
            dot.cornerRadius = 2;
        }
    }
}

function renderHeader(widget, data) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const todayCell = data.week_strip?.find((c) => c.is_today);
    const realToday = todayCell?.date ?? data.today.date;
    const viewingPast = data.today.date !== realToday;

    const title = row.addText(
        spaceCaps(viewingPast ? "PAST DAY" : "TODAY"),
    );
    title.font = Font.semiboldSystemFont(9);
    title.textColor = COLOR_MUTED;

    row.addSpacer();

    const wk = fmtWeekday(data.today.date);
    const sd = fmtShortDate(data.today.date);
    const datePart = row.addText(`${wk}, ${sd}`);
    datePart.font = Font.regularSystemFont(10);
    datePart.textColor = COLOR_MUTED;
}

function renderCalories(widget, data) {
    const t = data.today;
    const target = t.calories_out || (t.eer ?? 0);
    const fraction = target > 0 ? t.calories_in / target : 0;

    // Quiet label above the hero number — Wallet-style.
    const lbl = widget.addText(spaceCaps("CONSUMED"));
    lbl.font = Font.semiboldSystemFont(8);
    lbl.textColor = COLOR_FAINT;

    widget.addSpacer(2);

    const bigRow = widget.addStack();
    bigRow.layoutHorizontally();
    bigRow.bottomAlignContent();
    bigRow.spacing = 4;

    const big = bigRow.addText(fmtNum(t.calories_in));
    big.font = heroFont(34);
    big.textColor = COLOR_FG;

    if (target > 0) {
        const targetLbl = bigRow.addText(`of ${fmtNum(target)} kcal`);
        targetLbl.font = Font.regularSystemFont(11);
        targetLbl.textColor = COLOR_MUTED;
    }

    bigRow.addSpacer();

    if (target > 0) {
        // Balance text only — no pill, no caps yelling. Color is the signal.
        const balText = bigRow.addText(
            t.balance < 0
                ? `${fmtSigned(t.balance)} deficit`
                : t.balance > 0
                  ? `+${fmtNum(t.balance)} surplus`
                  : "balanced",
        );
        balText.font = Font.semiboldSystemFont(11);
        balText.textColor =
            t.balance < 0
                ? COLOR_ACCENT
                : t.balance > 0
                  ? COLOR_WARNING
                  : COLOR_MUTED;
    }

    widget.addSpacer(8);
    addProgressBar(widget, fraction, COLOR_ACCENT, 326, 3);
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

function renderForecast(widget, data) {
    const f = data.weight_forecast ?? {
        targets: [],
        method: "insufficient_data",
        current_kg: null,
        slope_kg_per_week: null,
        rationale: "",
    };

    addSectionLabel(widget, "If you nail it", "your best pace, sustained");
    widget.addSpacer(4);

    const targetsByGoal = new Map(
        (f.targets ?? []).map((t) => [t.goal_kg, t]),
    );

    for (let i = 0; i < FORECAST_GOALS.length; i++) {
        const goal = FORECAST_GOALS[i];
        const t = targetsByGoal.get(goal);

        // Pure typographic rows, slightly bigger than before — this is the
        // headline metric of the widget so the type carries it.
        const row = widget.addStack();
        row.layoutHorizontally();
        row.centerAlignContent();
        row.spacing = 0;

        const goalText = row.addText(`${goal} kg`);
        goalText.font = Font.boldSystemFont(15);
        goalText.textColor = COLOR_FG;

        row.addSpacer();

        if (!t) {
            const muted = row.addText("—");
            muted.font = Font.regularSystemFont(13);
            muted.textColor = COLOR_MUTED;
        } else if (t.reached) {
            const reached = row.addText("reached ✓");
            reached.font = Font.semiboldSystemFont(13);
            reached.textColor = COLOR_ACCENT;
        } else if (t.eta_date && t.eta_days != null) {
            const dateText = row.addText(fmtShortDate(t.eta_date));
            dateText.font = Font.boldSystemFont(15);
            dateText.textColor = COLOR_ACCENT;

            row.addSpacer(10);

            const daysText = row.addText(
                t.eta_days > 365
                    ? `${(t.eta_days / 365).toFixed(1)} yr`
                    : `${t.eta_days} days`,
            );
            daysText.font = Font.regularSystemFont(12);
            daysText.textColor = COLOR_MUTED;
        } else {
            const muted = row.addText("awaiting data");
            muted.font = Font.regularSystemFont(11);
            muted.textColor = COLOR_MUTED;
        }

        widget.addSpacer(4);
        // Hairline between rows (skip after last)
        if (i < FORECAST_GOALS.length - 1) {
            addDivider(widget);
            widget.addSpacer(4);
        }
    }

    // Rationale subtitle — small, italic-feeling, just below the rows.
    if (f.rationale) {
        widget.addSpacer(2);
        const r = widget.addText(f.rationale);
        r.font = Font.regularSystemFont(10);
        r.textColor = COLOR_MUTED;
        r.lineLimit = 1;
    }
}

function renderWeightGraph(widget, data) {
    const weeks = data.weight_graph?.weeks ?? [];

    const filled = weeks.filter((w) => w.min_weight_kg != null);
    const currentKg = filled.length
        ? filled[filled.length - 1].min_weight_kg
        : null;
    let suffix;
    if (filled.length >= 2) {
        const first = filled[0].min_weight_kg;
        const last = filled[filled.length - 1].min_weight_kg;
        const delta = last - first;
        const deltaTxt = `${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg · 8w`;
        suffix =
            currentKg != null
                ? `${currentKg.toFixed(1)} kg · ${deltaTxt}`
                : deltaTxt;
    } else if (currentKg != null) {
        suffix = `${currentKg.toFixed(1)} kg`;
    } else {
        suffix = "8w trend";
    }
    addSectionLabel(widget, "WEIGHT", suffix);

    widget.addSpacer(2);
    const img = buildWeightGraphImage(weeks, FORECAST_GOALS, 326, 78);
    if (img) {
        widget.addImage(img);
    } else {
        const note = widget.addText(
            "Log at least 2 weekly weights to see the trend.",
        );
        note.font = Font.systemFont(10);
        note.textColor = COLOR_MUTED;
    }
}

function renderFooter(widget, data) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    row.spacing = 10;

    const parts = [];
    if (data.today.steps > 0) {
        parts.push(`${fmtNum(data.today.steps)} steps`);
    }
    parts.push(`wk ${fmtSigned(data.week.avg_balance)}/d`);

    const left = row.addText(parts.join("   "));
    left.font = Font.regularSystemFont(9);
    left.textColor = COLOR_MUTED;

    row.addSpacer();

    const ts = row.addText(
        new Date().toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
        }),
    );
    ts.font = Font.regularSystemFont(9);
    ts.textColor = COLOR_FAINT;
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
//
// Three launch modes:
//   1. Running inside the widget (config.runsInWidget) — render normally.
//   2. Launched via URL (any tap on the widget — either a day cell with
//      ?date= or the whole widget with ?reset=1) — update persisted state
//      and exit WITHOUT presenting. Scriptable barely flashes before iOS
//      returns to the home screen, and the widget picks up the new state
//      on its next refresh (hinted to ~2 min).
//   3. Manual run from inside Scriptable — render once for preview.
const __launchSelected = readSelectedDateFromArgs();
const __launchedFromUrl =
    !!__launchSelected || args?.queryParameters?.reset === "1";

if (config.runsInWidget) {
    const widget = await build();
    Script.setWidget(widget);
} else if (__launchedFromUrl) {
    // Tap-from-widget. Update state silently.
    if (__launchSelected) writePersistedSelection(__launchSelected);
    else clearPersistedSelection();
} else {
    // Manual run from the Scriptable app — show the preview so the user
    // can see what's happening while building / debugging.
    const widget = await build();
    widget.presentLarge();
}
Script.complete();
