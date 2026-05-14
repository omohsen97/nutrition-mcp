// =============================================================================
// Nutrition dashboard — Scriptable LARGE widget · v5.0.0 (editorial redesign)
//
// Editorial bone structure per the design handoff:
//   - New York (system serif) for hero numerals, italic for the deficit
//   - System sans for everything else, small-caps + tracking on labels
//   - Two palettes — Sunset (editorial cream) | Vault (fintech) — switchable
//     via ?palette=vault on the widget's URL (or default to sunset)
//
// This file is fetched by the local bootstrap on every refresh, so any change
// committed and deployed here lands on the phone automatically. The bootstrap
// declares API_URL and API_TOKEN before eval()ing this code.
// =============================================================================

const WIDGET_VERSION = "5.1.8";
const FORECAST_GOALS = [115, 110];

// ---------- Palettes ----------
//
// Pulled verbatim from the design handoff (§2). Two palettes × two themes.
// Selected via `?palette=sunset|vault` on the widget URL (defaults to sunset).
const PALETTES = {
    sunset: {
        light: {
            card: "#fbf5e6",
            ink1: "#1f140c",
            ink2: "#6a5945",
            ink3: "#a89878",
            ink4: "#d1c3a4",
            rule: ["#1f140c", 0.1],
            ruleSoft: ["#1f140c", 0.06],
            track: ["#1f140c", 0.08],
            protein: "#e04e2a",
            carbs: "#e0a21a",
            fat: "#7a52d0",
            positive: "#1e8e5c",
            today: "#d6336e",
            chartLine: "#1f140c",
        },
        dark: {
            card: "#16110a",
            ink1: "#f7efdb",
            ink2: "#bbae94",
            ink3: "#857967",
            ink4: "#3a3128",
            rule: ["#f7efdb", 0.16],
            ruleSoft: ["#f7efdb", 0.08],
            track: ["#f7efdb", 0.14],
            protein: "#ff8260",
            carbs: "#ffcb55",
            fat: "#b49cff",
            positive: "#6ee6ac",
            today: "#ff6b92",
            chartLine: "#f7efdb",
        },
    },
    vault: {
        light: {
            card: "#f6f6f8",
            ink1: "#0b0f18",
            ink2: "#5a6072",
            ink3: "#9097a8",
            ink4: "#bfc4d2",
            rule: ["#0b0f18", 0.1],
            ruleSoft: ["#0b0f18", 0.06],
            track: ["#0b0f18", 0.08],
            protein: "#e5006a",
            carbs: "#ffb400",
            fat: "#1466ff",
            positive: "#00a86b",
            today: "#ff2e63",
            chartLine: "#0b0f18",
        },
        dark: {
            card: "#0a0b0f",
            ink1: "#f5f7fb",
            ink2: "#aab3ca",
            ink3: "#737c90",
            ink4: "#2e3447",
            rule: ["#f5f7fb", 0.18],
            ruleSoft: ["#f5f7fb", 0.08],
            track: ["#f5f7fb", 0.14],
            protein: "#ff4d90",
            carbs: "#ffd850",
            fat: "#6d9aff",
            positive: "#5cf5a8",
            today: "#ff6680",
            chartLine: "#f5f7fb",
        },
    },
};

function pickPalette() {
    // Default to Vault — owner confirmed it as the target via Claude Design
    // reference. Sunset stays available with ?palette=sunset for fall use.
    const name = readQueryParam("palette") ?? "vault";
    const isDark = !!(Device.isUsingDarkAppearance && Device.isUsingDarkAppearance());
    const palette = PALETTES[name] ?? PALETTES.vault;
    return palette[isDark ? "dark" : "light"];
}

// Convert a hex (or hex+alpha tuple) from the palette into a Scriptable Color.
function color(spec) {
    if (Array.isArray(spec)) return new Color(spec[0], spec[1]);
    return new Color(spec);
}

// ---------- Fonts ----------
//
// New York is on every modern iOS device. Falls back to bold system if not
// resolvable (older iOS).
function serif(size) {
    return new Font("NewYorkLarge-Regular", size);
}
function serifItalic(size) {
    return new Font("NewYorkLarge-Italic", size);
}
// Tiny caps eyebrow text.
function eyebrowFont(size) {
    return Font.semiboldSystemFont(size);
}

// ---------- Helpers ----------
function fmtNum(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(n).toLocaleString("en-US");
}
// Compact 4-char form used by the week chart cells where horizontal room is
// tight — drops the thousands comma so "3,633" → "3633" and we stop relying
// on optical-variant font resolution to fit.
function fmtNumCompact(n) {
    if (n == null || isNaN(n)) return "—";
    return String(Math.round(n));
}
function fmtSigned(n) {
    if (n == null || isNaN(n)) return "—";
    const r = Math.round(n);
    if (r === 0) return "0";
    // U+2212 minus sign rather than hyphen-minus — proper typography.
    return r > 0
        ? `+${r.toLocaleString("en-US")}`
        : `−${Math.abs(r).toLocaleString("en-US")}`;
}
function fmtShortDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
    return `${d.toLocaleString("en-US", { month: "short" })} ${String(d.getDate()).padStart(2, "0")}`;
}
function fmtMonthDay(iso) {
    if (!iso) return "";
    const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
    return `${d.toLocaleString("en-US", { month: "short" }).toUpperCase()} ${d.getDate()}`;
}
function fmtWeekday(iso) {
    if (!iso) return "";
    const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
    return d.toLocaleString("en-US", { weekday: "short" }).toUpperCase();
}
// Manually space caps for the tracking effect Scriptable can't do natively.
function spaceCaps(s) {
    return s.toUpperCase().split("").join(" ");
}

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

function readQueryParam(name) {
    try {
        const v = args?.queryParameters?.[name];
        if (typeof v === "string" && v.length > 0) return v;
    } catch {}
    return null;
}
function readSelectedDateFromArgs() {
    const d = readQueryParam("date");
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// ---------- Day-selection persistence (same scheme as v4.x) ----------
function selectionStatePath() {
    const fm = FileManager.local();
    return fm.joinPath(
        fm.documentsDirectory(),
        "_nutrition-widget-selection.json",
    );
}
function readPersistedSelection() {
    const fm = FileManager.local();
    const p = selectionStatePath();
    if (!fm.fileExists(p)) return null;
    try {
        const raw = JSON.parse(fm.readString(p));
        if (!raw?.date || typeof raw.date !== "string") return null;
        // 2-hour TTL — long enough to browse a past day for the evening,
        // short enough that overnight the widget reverts to today on its own.
        // 24h was way too sticky and surprised the owner with yesterday's
        // data on a Tuesday morning.
        if (Date.now() - (Number(raw.savedAt) || 0) > 2 * 60 * 60 * 1000)
            return null;
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
    const p = selectionStatePath();
    if (fm.fileExists(p)) fm.remove(p);
}

// ---------- DrawContext primitives ----------

// Draws the calorie gradient bar (protein → carbs → fat) at the given fill
// fraction, with a small target tick at the right edge. Returns a Scriptable
// Image. Coordinates are in display points — respectScreenScale handles
// retina internally so we don't oversample manually (doing so renders the
// image at the oversampled point size and either overflows or scales weird
// inside the parent stack).
function buildCalorieBarImage(palette, fraction, widthPt, heightPt) {
    const w = widthPt;
    const h = heightPt;
    // Extra vertical room for the target tick (extends 2pt above + below).
    const tickExt = 2;
    const totalH = h + tickExt * 2;
    const ctx = new DrawContext();
    ctx.size = new Size(w, totalH);
    ctx.opaque = false;
    ctx.respectScreenScale = true;
    const barY = tickExt;
    // Track
    ctx.setFillColor(color(palette.track));
    ctx.addPath(roundedRectPath(0, barY, w, h, h / 2));
    ctx.fillPath();
    // Fill — sample protein → carbs → fat per-pixel so the gradient blends
    // smoothly. Per-pixel scan is fine at point-resolution widths.
    const fw = Math.max(2, Math.min(w, w * fraction));
    const segments = [
        { color: palette.protein, t: 0 },
        { color: palette.carbs, t: 0.5 },
        { color: palette.fat, t: 1 },
    ];
    for (let x = 0; x < fw; x += 0.5) {
        const t = x / Math.max(1, fw - 1);
        const c = sampleGradient(segments, t);
        ctx.setFillColor(color(c));
        ctx.fillRect(new Rect(x, barY, 0.7, h));
    }
    // Target tick at the right edge — vertical line extending above + below
    // the bar at 50% opacity, ink2 color.
    ctx.setFillColor(new Color(palette.ink2, 0.5));
    ctx.fillRect(new Rect(w - 1.5, 0, 1.5, totalH));
    return ctx.getImage();
}

function sampleGradient(stops, t) {
    for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i],
            b = stops[i + 1];
        if (t >= a.t && t <= b.t) {
            const local = (t - a.t) / (b.t - a.t);
            return lerpHex(a.color, b.color, local);
        }
    }
    return stops[stops.length - 1].color;
}
function lerpHex(a, b, t) {
    const pa = hexToRgb(a),
        pb = hexToRgb(b);
    const r = Math.round(pa.r + (pb.r - pa.r) * t);
    const g = Math.round(pa.g + (pb.g - pa.g) * t);
    const blue = Math.round(pa.b + (pb.b - pa.b) * t);
    return `#${[r, g, blue].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

// Generic flat rounded rect path generator.
function roundedRectPath(x, y, w, h, r) {
    const p = new Path();
    p.addRoundedRect(new Rect(x, y, w, h), r, r);
    return p;
}

// Macro progress bar with the macro color.
function buildMacroBarImage(palette, fraction, widthPt, heightPt, fillHex) {
    const w = widthPt;
    const h = heightPt;
    const ctx = new DrawContext();
    ctx.size = new Size(w, h);
    ctx.opaque = false;
    ctx.respectScreenScale = true;
    ctx.setFillColor(color(palette.track));
    ctx.addPath(roundedRectPath(0, 0, w, h, h / 2));
    ctx.fillPath();
    const fw = Math.max(2, Math.min(w, w * fraction));
    ctx.setFillColor(color(fillHex));
    ctx.addPath(roundedRectPath(0, 0, fw, h, h / 2));
    ctx.fillPath();
    return ctx.getImage();
}

// Sparkline image with positive-color area fill + last-point halo.
// Coordinates in display points — respectScreenScale handles retina.
function buildSparklineImage(weeks, palette, widthPt, heightPt) {
    const w = widthPt;
    const h = heightPt;
    const ctx = new DrawContext();
    ctx.size = new Size(w, h);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    const points = weeks
        .map((wk, i) => ({ i, v: wk.min_weight_kg }))
        .filter((p) => p.v != null);
    if (points.length < 2) {
        ctx.setTextColor(color(palette.ink3));
        ctx.setFont(Font.systemFont(9));
        ctx.drawTextInRect(
            "log 2+ weights to see trend",
            new Rect(0, h / 2 - 5, w, 12),
        );
        return ctx.getImage();
    }

    const padTop = 4;
    const padBottom = 4;
    const padLeft = 1;
    const padRight = 1;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;
    const totalWeeks = weeks.length;
    const values = points.map((p) => p.v);
    const minV = Math.min(...values) - 0.4;
    const maxV = Math.max(...values) + 0.25;
    const range = Math.max(0.5, maxV - minV);
    const xFor = (i) => padLeft + (i / Math.max(1, totalWeeks - 1)) * plotW;
    const yFor = (v) => padTop + plotH - ((v - minV) / range) * plotH;

    // Area fill — draw filled polygon from line down to baseline with
    // positive color at low opacity. (Approximation; gradient → 0 not
    // expressible per-pixel without canvas trickery, so we use a single
    // low-alpha fill.)
    const areaPath = new Path();
    let first = true;
    for (const p of points) {
        const x = xFor(p.i);
        const y = yFor(p.v);
        if (first) {
            areaPath.move(new Point(x, y));
            first = false;
        } else {
            areaPath.addLine(new Point(x, y));
        }
    }
    areaPath.addLine(new Point(xFor(points[points.length - 1].i), h - padBottom));
    areaPath.addLine(new Point(xFor(points[0].i), h - padBottom));
    // Scriptable's Path doesn't expose closeSubpath(); fillPath() closes
    // the polygon implicitly when filling, so the area still renders.
    ctx.setFillColor(new Color(palette.positive, 0.18));
    ctx.addPath(areaPath);
    ctx.fillPath();

    // Target hairline at 86% of plot height (matches handoff)
    const tgY = padTop + plotH * 0.86;
    drawDashedLine(
        ctx,
        padLeft,
        tgY,
        w - padRight,
        tgY,
        new Color(palette.ink3, 0.65),
        0.6,
        2,
        2,
    );

    // Line
    const linePath = new Path();
    first = true;
    for (const p of points) {
        const x = xFor(p.i),
            y = yFor(p.v);
        if (first) {
            linePath.move(new Point(x, y));
            first = false;
        } else {
            linePath.addLine(new Point(x, y));
        }
    }
    ctx.setStrokeColor(color(palette.chartLine));
    ctx.setLineWidth(1.2);
    ctx.addPath(linePath);
    ctx.strokePath();

    // Dots — last one with halo in positive color
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const x = xFor(p.i),
            y = yFor(p.v);
        const isLast = i === points.length - 1;
        if (isLast) {
            ctx.setFillColor(new Color(palette.positive, 0.22));
            const hr = 4;
            ctx.fillEllipse(new Rect(x - hr, y - hr, hr * 2, hr * 2));
        }
        const r = isLast ? 2.4 : 1.6;
        ctx.setFillColor(
            isLast ? color(palette.positive) : color(palette.chartLine),
        );
        ctx.fillEllipse(new Rect(x - r, y - r, r * 2, r * 2));
    }

    return ctx.getImage();
}

function drawDashedLine(ctx, x1, y1, x2, y2, col, width, dash, gap) {
    ctx.setStrokeColor(col);
    ctx.setLineWidth(width);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len,
        uy = (y2 - y1) / len;
    let pos = 0;
    while (pos < len) {
        const sx = x1 + ux * pos;
        const sy = y1 + uy * pos;
        const ex = x1 + ux * Math.min(pos + dash, len);
        const ey = y1 + uy * Math.min(pos + dash, len);
        const p = new Path();
        p.move(new Point(sx, sy));
        p.addLine(new Point(ex, ey));
        ctx.addPath(p);
        ctx.strokePath();
        pos += dash + gap;
    }
}

// Week bar chart image — 7 bars with target hairline. Day letters + values
// are rendered as widget text outside this image so they react to dynamic
// type sizing if iOS scales it.
// One DrawContext for the whole week chart: bars + value + delta per column.
// Doing it in a single canvas avoids Scriptable's stack-width truncation
// (40pt cells can't fit "3,453" + commas at 12pt serif so the labels were
// being clipped to "3,..." in v5.1).
function buildWeekChartImage(weekStrip, target, palette, widthPt, heightPt) {
    const w = widthPt;
    const h = heightPt;
    const ctx = new DrawContext();
    ctx.size = new Size(w, h);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    if (!weekStrip || weekStrip.length === 0) return ctx.getImage();

    // Vertical budget (in points, top to bottom):
    //   barAreaH  the bars themselves
    //   2         spacing
    //   valueH    the value row (serif)
    //   1         spacing
    //   deltaH    the delta row (sans semibold)
    const valueH = 12;
    const deltaH = 9;
    const barAreaH = h - valueH - deltaH - 2 - 1 - 2; // 2pt top padding
    const padTop = 2;

    // gap 4 + 9pt serif gives cells ~38pt with ~12pt of visual whitespace
    // between adjacent values (5-digit "3,632" is ~25pt at 9pt serif). The
    // earlier gap=2 / font=10 combo fit the digits but values rendered
    // wall-to-wall and looked like one long string.
    const cells = weekStrip.length;
    const gap = 4;
    const colW = (w - gap * (cells - 1)) / cells;
    const barW = colW * 0.58;
    const values = weekStrip.map((c) => c.calories_in);
    const max = Math.max(target * 1.1, ...values, 1);

    // Target dashed line through the bar area
    const tgY = padTop + barAreaH - (target / max) * barAreaH;
    drawDashedLine(
        ctx,
        0,
        tgY,
        w,
        tgY,
        new Color(palette.ink3, 0.5),
        0.6,
        2,
        2,
    );

    weekStrip.forEach((c, i) => {
        const colX = i * (colW + gap);
        const barX = colX + (colW - barW) / 2;
        const barH = Math.max(0.5, (c.calories_in / max) * barAreaH);
        const barY = padTop + barAreaH - barH;
        const over = c.calories_in > target;
        const barColor = c.is_today
            ? palette.today
            : over
              ? palette.protein
              : palette.positive;
        const barAlpha = c.is_today ? 1 : 0.85;
        ctx.setFillColor(new Color(barColor, barAlpha));
        ctx.addPath(roundedRectPath(barX, barY, barW, barH, 1.5));
        ctx.fillPath();

        // Value centered below the bar. Switched away from NewYork serif —
        // NewYorkLarge's glyphs were too wide at 9pt to fit "3,633" in a
        // 38pt cell, and NewYorkSmall (the correct optical variant) doesn't
        // reliably resolve on every iOS build (Scriptable falls back to the
        // current font, not necessarily something narrower). System sans
        // (San Francisco) is half the width and renders identically on
        // every device. Combined with `fmtNumCompact` (no thousands comma),
        // "3633" at 9pt is ~16pt — fits with huge slack regardless of font.
        const valueY = padTop + barAreaH + 2;
        const valueRect = new Rect(colX, valueY, colW, valueH);
        ctx.setTextColor(c.is_today ? color(palette.ink1) : color(palette.ink2));
        ctx.setFont(Font.regularSystemFont(9));
        ctx.setTextAlignedCenter();
        ctx.drawTextInRect(fmtNumCompact(c.calories_in), valueRect);

        // Delta (sans semibold) under the value
        const delta = c.calories_in - target;
        const deltaY = valueY + valueH + 1;
        const deltaRect = new Rect(colX, deltaY, colW, deltaH);
        ctx.setTextColor(
            over ? color(palette.protein) : color(palette.positive),
        );
        ctx.setFont(Font.semiboldSystemFont(8));
        ctx.setTextAlignedCenter();
        ctx.drawTextInRect(fmtSigned(delta), deltaRect);
    });

    return ctx.getImage();
}

// ---------- Layout helpers ----------
function spacer(widget, h) {
    widget.addSpacer(h);
}
function rule(widget, palette, soft = false) {
    const r = widget.addStack();
    r.backgroundColor = color(soft ? palette.ruleSoft : palette.rule);
    r.size = new Size(0, 1);
}

// ---------- Renderers ----------

function renderHeader(widget, data, palette) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const todayCell = data.week_strip?.find((c) => c.is_today);
    const realToday = todayCell?.date ?? data.today.date;
    const viewingPast = data.today.date !== realToday;

    // "Today" label first, then the rose dot to the right (matches React ref).
    const leftWrap = row.addStack();
    leftWrap.layoutHorizontally();
    leftWrap.centerAlignContent();
    leftWrap.spacing = 6;

    const lbl = leftWrap.addText(viewingPast ? "Past day" : "Today");
    lbl.font = serifItalic(17);
    lbl.textColor = color(palette.ink1);

    // Halo around the dot. Use a slightly larger transparent stack with the
    // today color at low alpha, then a smaller solid stack on top centered
    // inside. Closest analog to the box-shadow halo in the React reference.
    const dotHalo = leftWrap.addStack();
    dotHalo.backgroundColor = new Color(palette.today, 0.22);
    dotHalo.cornerRadius = 6;
    dotHalo.size = new Size(11, 11);
    dotHalo.layoutHorizontally();
    dotHalo.centerAlignContent();
    dotHalo.setPadding(3, 3, 3, 3);
    const dotInner = dotHalo.addStack();
    dotInner.backgroundColor = color(palette.today);
    dotInner.cornerRadius = 3;
    dotInner.size = new Size(5, 5);

    row.addSpacer();

    const dateLbl = row.addText(
        `${fmtWeekday(data.today.date)} · ${fmtMonthDay(data.today.date)}`,
    );
    dateLbl.font = eyebrowFont(9);
    dateLbl.textColor = color(palette.ink3);
}

function renderInsight(widget, data, palette) {
    const text = widget.addText(data.insight.text);
    text.font = Font.regularSystemFont(11);
    text.textColor = color(palette.ink2);
    text.lineLimit = 1;
}

function renderHero(widget, data, palette) {
    const t = data.today;
    const target = t.calories_out || t.eer || 0;

    const row = widget.addStack();
    row.layoutHorizontally();
    row.bottomAlignContent();

    // Left column
    const left = row.addStack();
    left.layoutVertically();
    left.spacing = 1;
    const eb = left.addText(spaceCaps("CONSUMED · KCAL"));
    eb.font = eyebrowFont(9);
    eb.textColor = color(palette.ink3);
    const numText = left.addText(fmtNum(t.calories_in));
    numText.font = serif(42);
    numText.textColor = color(palette.ink1);
    if (target > 0) {
        const tlbl = left.addText(`of ${fmtNum(target)} target`);
        tlbl.font = Font.regularSystemFont(10);
        tlbl.textColor = color(palette.ink3);
    }

    row.addSpacer();

    // Right column — deficit/surplus
    if (target > 0) {
        const right = row.addStack();
        right.layoutVertically();
        right.spacing = 1;
        const isDeficit = t.balance < 0;
        const balLabel = isDeficit
            ? "DEFICIT"
            : t.balance > 0
              ? "SURPLUS"
              : "BALANCED";
        const balColor = isDeficit
            ? palette.positive
            : t.balance > 0
              ? palette.protein
              : palette.ink2;
        // Eyebrow
        const balEb = right.addText(spaceCaps(balLabel));
        balEb.font = eyebrowFont(9);
        balEb.textColor = color(balColor);
        // Right-align by using a horizontal sub-stack with spacer
        const balRow = right.addStack();
        balRow.layoutHorizontally();
        balRow.addSpacer();
        const balText = balRow.addText(
            t.balance === 0
                ? "0"
                : t.balance < 0
                  ? `−${Math.abs(t.balance).toLocaleString("en-US")}`
                  : `+${t.balance.toLocaleString("en-US")}`,
        );
        balText.font = serifItalic(30);
        balText.textColor = color(balColor);
    }
}

function renderCalorieBar(widget, data, palette) {
    const t = data.today;
    const target = t.calories_out || t.eer || 0;
    const frac = target > 0 ? Math.max(0, Math.min(1, t.calories_in / target)) : 0;
    const img = buildCalorieBarImage(palette, frac, 290, 4);
    const wImg = widget.addImage(img);
    // Explicit imageSize prevents Scriptable from shrinking the image when
    // the widget runs out of vertical budget.
    wImg.imageSize = new Size(290, 8);
}

function renderMacros(widget, data, palette) {
    const t = data.today;
    const tgt = data.today.targets_known;
    const row = widget.addStack();
    row.layoutHorizontally();
    row.spacing = 12;

    const cols = [
        {
            name: "PROTEIN",
            actual: t.macros.protein_g.actual,
            target: tgt ? t.macros.protein_g.target_rda : null,
            color: palette.protein,
        },
        {
            name: "CARBS",
            actual: t.macros.carbs_g.actual,
            target: tgt ? t.macros.carbs_g.target_rda : null,
            color: palette.carbs,
        },
        {
            name: "FAT",
            actual: t.macros.fat_g.actual,
            target:
                tgt && t.macros.fat_g.target_min && t.macros.fat_g.target_max
                    ? (t.macros.fat_g.target_min + t.macros.fat_g.target_max) /
                      2
                    : null,
            color: palette.fat,
        },
    ];

    for (const c of cols) {
        const col = row.addStack();
        col.layoutVertically();
        col.spacing = 5;
        col.size = new Size(88, 0);

        // Top rule
        const top = col.addStack();
        top.backgroundColor = color(palette.rule);
        top.size = new Size(0, 1);

        col.addSpacer(4);

        // Header: full macro name + percentage
        const head = col.addStack();
        head.layoutHorizontally();
        head.centerAlignContent();
        const lt = head.addText(spaceCaps(c.name));
        lt.font = eyebrowFont(8.5);
        lt.textColor = color(c.color);
        head.addSpacer();
        if (c.target) {
            const pct = head.addText(
                `${Math.round((c.actual / c.target) * 100)}%`,
            );
            pct.font = Font.regularSystemFont(9);
            pct.textColor = color(palette.ink3);
        }

        // Value row
        const vals = col.addStack();
        vals.layoutHorizontally();
        vals.bottomAlignContent();
        vals.spacing = 2;
        const cur = vals.addText(`${Math.round(c.actual)}`);
        cur.font = serif(17);
        cur.textColor = color(palette.ink1);
        const slash = vals.addText(
            c.target ? ` /${Math.round(c.target)}g` : "g",
        );
        slash.font = Font.regularSystemFont(9);
        slash.textColor = color(palette.ink3);

        // Progress bar
        const fraction = c.target ? Math.max(0, Math.min(1, c.actual / c.target)) : 0;
        const barImg = buildMacroBarImage(palette, fraction, 88, 3, c.color);
        const wBar = col.addImage(barImg);
        wBar.imageSize = new Size(88, 3);
    }
}

function renderForecastAndWeight(widget, data, palette) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.spacing = 14;
    row.topAlignContent();

    // Forecast column
    const fc = row.addStack();
    fc.layoutVertically();
    fc.spacing = 4;
    fc.size = new Size(140, 0);

    const fcEb = fc.addText(spaceCaps("FORECAST"));
    fcEb.font = eyebrowFont(9);
    fcEb.textColor = color(palette.ink3);

    const f = data.weight_forecast ?? { targets: [], rationale: "" };
    const targets = f.targets ?? [];
    for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const frow = fc.addStack();
        frow.layoutHorizontally();
        frow.bottomAlignContent();
        frow.spacing = 4;

        const kg = frow.addText(`${t.goal_kg}`);
        kg.font = serif(14);
        kg.textColor = color(palette.ink1);
        const kgu = frow.addText("kg");
        kgu.font = Font.regularSystemFont(9);
        kgu.textColor = color(palette.ink3);

        frow.addSpacer();

        if (t.reached) {
            const r = frow.addText("reached");
            r.font = serifItalic(13);
            r.textColor = color(palette.positive);
        } else if (t.eta_date && t.eta_days != null) {
            const d = frow.addText(fmtShortDate(t.eta_date));
            d.font = serifItalic(13);
            d.textColor = color(i === 0 ? palette.today : palette.fat);
            const days = frow.addText(` · ${t.eta_days}d`);
            days.font = Font.regularSystemFont(9);
            days.textColor = color(palette.ink3);
        } else {
            const m = frow.addText("awaiting data");
            m.font = Font.regularSystemFont(9);
            m.textColor = color(palette.ink3);
        }
    }
    if (f.rationale) {
        fc.addSpacer(2);
        const pace = fc.addText(`at 0.${(((Math.abs(f.slope_kg_per_week) || 0) * 100) | 0).toString().padStart(2, "0")} kg/wk pace`);
        pace.font = serifItalic(9);
        pace.textColor = color(palette.ink3);
    }

    // Weight column
    const wc = row.addStack();
    wc.layoutVertically();
    wc.spacing = 3;
    wc.size = new Size(150, 0);

    const wh = wc.addStack();
    wh.layoutHorizontally();
    wh.centerAlignContent();
    const wEb = wh.addText(spaceCaps("WEIGHT"));
    wEb.font = eyebrowFont(9);
    wEb.textColor = color(palette.ink3);
    wh.addSpacer();
    const filled = (data.weight_graph?.weeks ?? []).filter(
        (w) => w.min_weight_kg != null,
    );
    if (filled.length) {
        const latest = filled[filled.length - 1].min_weight_kg;
        const delta = filled.length >= 2 ? latest - filled[0].min_weight_kg : 0;
        const sumWrap = wh.addStack();
        sumWrap.layoutHorizontally();
        sumWrap.spacing = 4;
        const latestT = sumWrap.addText(latest.toFixed(1));
        latestT.font = Font.semiboldSystemFont(10);
        latestT.textColor = color(palette.ink1);
        if (filled.length >= 2) {
            const deltaText = sumWrap.addText(
                `${delta < 0 ? "−" : delta > 0 ? "+" : ""}${Math.abs(delta).toFixed(1)}`,
            );
            deltaText.font = Font.semiboldSystemFont(10);
            deltaText.textColor = color(palette.positive);
        }
    }

    const sparkImg = buildSparklineImage(
        data.weight_graph?.weeks ?? [],
        palette,
        150,
        36,
    );
    const wSpark = wc.addImage(sparkImg);
    wSpark.imageSize = new Size(150, 36);
}

function renderWeekBars(widget, data, palette) {
    const t = data.today;
    const target = t.calories_out || t.eer || 0;

    // Header row
    const head = widget.addStack();
    head.layoutHorizontally();
    head.centerAlignContent();
    const eb = head.addText(spaceCaps("WEEK · KCAL"));
    eb.font = eyebrowFont(9);
    eb.textColor = color(palette.ink3);
    head.addSpacer();
    const right = head.addStack();
    right.layoutHorizontally();
    right.spacing = 0;
    const r1 = right.addText("avg ");
    r1.font = Font.regularSystemFont(9);
    r1.textColor = color(palette.ink2);
    const r2 = right.addText(fmtNum(data.week.avg_calories));
    r2.font = Font.semiboldSystemFont(9);
    r2.textColor = color(palette.ink1);
    const r3 = right.addText(` · target ${fmtNum(target)}`);
    r3.font = Font.regularSystemFont(9);
    r3.textColor = color(palette.ink2);

    widget.addSpacer(3);

    // Day letters row
    const cells = data.week_strip ?? [];
    if (cells.length === 0) return;
    const dl = widget.addStack();
    dl.layoutHorizontally();
    dl.spacing = 0;
    for (const c of cells) {
        const cell = dl.addStack();
        cell.size = new Size(40, 0);
        cell.layoutHorizontally();
        cell.addSpacer();
        const letter = cell.addText(c.weekday_short);
        letter.font = c.is_today
            ? Font.boldSystemFont(9)
            : Font.semiboldSystemFont(9);
        letter.textColor = c.is_today
            ? color(palette.today)
            : color(palette.ink3);
        cell.addSpacer();
        // Tap target — wraps the same cell
        cell.url =
            "scriptable:///run/" +
            encodeURIComponent(Script.name()) +
            "?date=" +
            encodeURIComponent(c.date);
    }

    widget.addSpacer(3);

    // Single DrawContext for bars + values + deltas — see buildWeekChartImage
    // comment for why we don't split this across widget stacks. Explicit
    // imageSize prevents Scriptable from squeezing this image when content
    // before it eats the height budget. Height trimmed from handoff §5.7's
    // 70pt to 58pt (bars ~32pt + 2pt gap + 12pt value + 1pt gap + 9pt delta
    // + 2pt pad). Saves 12pt of vertical so the footer stops getting clipped
    // on standard iPhone large widgets (338×354pt). Bars are between v5.0's
    // 25pt and v5.1's 42pt — best fidelity the height budget allows.
    const chartImg = buildWeekChartImage(cells, target, palette, 290, 58);
    const wChart = widget.addImage(chartImg);
    wChart.imageSize = new Size(290, 58);
}

function renderFooter(widget, data, palette) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    row.spacing = 0;

    const stepsT = row.addText(fmtNum(data.today.steps));
    stepsT.font = Font.semiboldSystemFont(9);
    stepsT.textColor = color(palette.carbs);
    const stepsLbl = row.addText(" steps · wk ");
    stepsLbl.font = Font.regularSystemFont(9);
    stepsLbl.textColor = color(palette.ink3);
    const wkT = row.addText(fmtSigned(data.week.avg_balance));
    wkT.font = Font.semiboldSystemFont(9);
    wkT.textColor =
        data.week.avg_balance < 0
            ? color(palette.positive)
            : color(palette.ink2);
    const wkLbl = row.addText("/d");
    wkLbl.font = Font.regularSystemFont(9);
    wkLbl.textColor = color(palette.ink3);

    row.addSpacer();

    const time = row.addText(
        new Date()
            .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
            .toUpperCase(),
    );
    time.font = Font.regularSystemFont(9);
    time.textColor = color(palette.ink3);
}

function renderError(widget, message, palette) {
    const title = widget.addText("Health tracker");
    title.font = serif(18);
    title.textColor = color(palette.ink1);
    widget.addSpacer(6);
    const err = widget.addText("⚠ " + message);
    err.font = Font.systemFont(11);
    err.textColor = color(palette.protein);
    widget.addSpacer();
    if (typeof API_TOKEN === "undefined" || API_TOKEN === "PASTE_YOUR_TOKEN_HERE") {
        const hint = widget.addText(
            "Open /dashboard/setup to mint a token.",
        );
        hint.font = Font.systemFont(10);
        hint.textColor = color(palette.ink3);
    }
}

// ---------- build() ----------
async function build() {
    const palette = pickPalette();

    const widget = new ListWidget();
    widget.backgroundColor = color(palette.card);
    // Symmetric 17pt padding keeps every corner glyph (Today / date / steps /
    // time) outside iOS's ~22pt rounded-corner mask — the old asymmetric
    // (15,17,13,17) put the bottom-corner text inside the curve so it looked
    // squidged against the rounded edges.
    widget.setPadding(17, 17, 17, 17);
    widget.url =
        "scriptable:///run/" +
        encodeURIComponent(Script.name()) +
        "?reset=1";
    widget.refreshAfterDate = new Date(Date.now() + 2 * 60 * 1000);

    const argDate = readSelectedDateFromArgs();
    const persisted = readPersistedSelection();
    const selectedDate = argDate ?? persisted ?? null;

    let data;
    try {
        data = await fetchPayload(selectedDate);
    } catch (err) {
        renderError(widget, err.message ?? String(err), palette);
        return widget;
    }

    // Vertical rhythm tightened to fit a 354pt widget with the 70pt week
    // chart we need for handoff-faithful bars. Every section gap shaved
    // — without this, the late-row images get clipped.
    renderHeader(widget, data, palette);
    if (data.insight?.text) {
        widget.addSpacer(2);
        renderInsight(widget, data, palette);
        widget.addSpacer(4);
    } else {
        widget.addSpacer(4);
    }
    rule(widget, palette);
    widget.addSpacer(3);
    renderHero(widget, data, palette);
    widget.addSpacer(3);
    renderCalorieBar(widget, data, palette);
    widget.addSpacer(3);
    renderMacros(widget, data, palette);
    widget.addSpacer(3);
    rule(widget, palette);
    widget.addSpacer(3);
    renderForecastAndWeight(widget, data, palette);
    widget.addSpacer(4);
    rule(widget, palette);
    widget.addSpacer(4);
    renderWeekBars(widget, data, palette);
    widget.addSpacer();
    rule(widget, palette, true);
    widget.addSpacer(4);
    renderFooter(widget, data, palette);

    return widget;
}

// ---------- Entrypoint ----------
const __launchSelected = readSelectedDateFromArgs();
const __resetReq = args?.queryParameters?.reset === "1";
const __launchedFromUrl = !!__launchSelected || __resetReq;

if (config.runsInWidget) {
    const widget = await build();
    Script.setWidget(widget);
} else if (__launchedFromUrl) {
    if (__launchSelected) writePersistedSelection(__launchSelected);
    else clearPersistedSelection();
} else {
    const widget = await build();
    widget.presentLarge();
}
Script.complete();
