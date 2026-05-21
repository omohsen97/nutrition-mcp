#!/usr/bin/env bun
/**
 * Polymarket airdrop weighted-volume calculator.
 *
 * Pulls a wallet's taker trades from the public Polymarket data-api,
 * enriches each trade with the event's category tags via gamma-api, then
 * computes weighted volume per the published formula:
 *
 *   wV = TradeSize × (1 − EntryPrice) × CategoryWeight × Bonuses
 *
 * Polymarket has not officially disclosed the category-weight table or
 * bonus multipliers as of this writing. Defaults below are 1.0 everywhere
 * so the raw wV is `size × price × (1 − price)`, which is symmetric for
 * BUY and SELL (selling YES at p is equivalent to buying NO at 1−p).
 * Edit CATEGORY_WEIGHTS / BONUSES once the official numbers are published.
 *
 * Usage:
 *   bun scripts/polymarket-airdrop-volume.ts <0x-wallet> [<0x-wallet> ...]
 *   bun scripts/polymarket-airdrop-volume.ts <wallet1> <wallet2> --window 30
 *   bun scripts/polymarket-airdrop-volume.ts <wallet1> <wallet2> --json > out.json
 *
 * Multiple wallets: each wallet is reported individually, then a combined
 * total across all wallets is printed at the end.
 *
 * Allocation estimate (always printed): three independent methodologies
 * produce a dollar estimate of the user's $POLY airdrop under low / mid /
 * high scenario assumptions. See ALLOCATION_SCENARIOS below for inputs.
 */

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const PAGE_SIZE = 500;

// Category weight table. Keys are matched case-insensitively against the
// event's tag labels returned by gamma-api. The first matching tag wins;
// otherwise DEFAULT_CATEGORY_WEIGHT is used. Replace with official values.
const CATEGORY_WEIGHTS: Record<string, number> = {
    Politics: 1.0,
    Sports: 1.0,
    Crypto: 1.0,
    Economics: 1.0,
    "Science & Tech": 1.0,
    Pop: 1.0,
};
const DEFAULT_CATEGORY_WEIGHT = 1.0;

// Bonus multipliers. Replace with official values when published.
const BONUSES = 1.0;

/**
 * Allocation-estimate scenario assumptions.
 *
 * fdvUsd:                Fully-diluted valuation of $POLY at TGE.
 * airdropPctOfSupply:    Share of total supply allocated to the airdrop.
 * traderShareOfAirdrop:  Share of the airdrop earmarked for traders
 *                        (the remainder is assumed to go to LPs / others).
 * platformWv30dUsd:      Estimated 30-day platform-wide weighted volume.
 *                        Derived from Polymarket's ~$10.3B April 2026 monthly
 *                        notional volume × an assumed wV/notional factor
 *                        (~0.18-0.22 for typical price distributions).
 * hyperliquidUsdPerWv:   Per-$1-of-wV airdrop value implied by the HYPE
 *                        airdrop (used in Methodology B). Hyperliquid
 *                        distributed ~310M HYPE (~$2.7B at peak) for several
 *                        $T of pre-launch perp volume. Adjusted downward for
 *                        prediction-market structure where wV << notional.
 *
 * All numbers are best-guess publicly-sourced estimates, not Polymarket
 * statements. Tweak liberally.
 */
interface AllocationScenario {
    name: string;
    fdvUsd: number;
    airdropPctOfSupply: number;
    traderShareOfAirdrop: number;
    platformWv30dUsd: number;
    hyperliquidUsdPerWv: number;
}

const ALLOCATION_SCENARIOS: AllocationScenario[] = [
    {
        name: "Low",
        fdvUsd: 5_000_000_000,
        airdropPctOfSupply: 0.05,
        traderShareOfAirdrop: 0.6,
        platformWv30dUsd: 2_500_000_000,
        hyperliquidUsdPerWv: 0.4,
    },
    {
        name: "Mid",
        fdvUsd: 10_000_000_000,
        airdropPctOfSupply: 0.075,
        traderShareOfAirdrop: 0.7,
        platformWv30dUsd: 2_000_000_000,
        hyperliquidUsdPerWv: 0.8,
    },
    {
        name: "High",
        fdvUsd: 20_000_000_000,
        airdropPctOfSupply: 0.1,
        traderShareOfAirdrop: 0.8,
        platformWv30dUsd: 1_500_000_000,
        hyperliquidUsdPerWv: 1.5,
    },
];

// Heuristic boost multipliers reported by third-party estimators
// (polyield, pm.wiki). Not officially confirmed by Polymarket.
const EARLY_USER_CUTOFF = Math.floor(
    new Date("2025-01-01T00:00:00Z").getTime() / 1000,
);
const EARLY_USER_BOOST = 1.5;
const PROFITABLE_TRADER_BOOST = 1.25;

interface Trade {
    proxyWallet: string;
    side: "BUY" | "SELL";
    asset: string;
    conditionId: string;
    size: number;
    price: number;
    timestamp: number;
    title: string;
    slug: string;
    eventSlug: string;
    outcome: string;
    outcomeIndex: number;
    transactionHash: string;
}

interface GammaTag {
    label?: string;
    slug?: string;
}

interface GammaEvent {
    slug: string;
    tags?: GammaTag[];
}

function parseArgs(argv: string[]): {
    wallets: string[];
    windowDays: number;
    json: boolean;
    profitable: boolean;
} {
    const args = argv.slice(2);
    const wallets = args
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((w) => w.toLowerCase());
    if (wallets.length === 0) {
        console.error(
            "Usage: bun scripts/polymarket-airdrop-volume.ts <0x-wallet> [<0x-wallet> ...] [--window 30] [--json] [--profitable]",
        );
        process.exit(1);
        throw new Error("unreachable");
    }
    const windowIdx = args.indexOf("--window");
    const windowArg = windowIdx >= 0 ? args[windowIdx + 1] : undefined;
    const windowDays = windowArg ? Number(windowArg) : 30;
    const json = args.includes("--json");
    const profitable = args.includes("--profitable");
    return { wallets, windowDays, json, profitable };
}

async function fetchAllTrades(wallet: string): Promise<Trade[]> {
    const trades: Trade[] = [];
    let offset = 0;
    while (true) {
        const url = `${DATA_API}/trades?user=${wallet}&limit=${PAGE_SIZE}&offset=${offset}&takerOnly=true`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `data-api /trades HTTP ${res.status} at offset ${offset}`,
            );
        }
        const page = (await res.json()) as Trade[];
        if (!Array.isArray(page) || page.length === 0) break;
        trades.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
    return trades;
}

async function fetchEventTags(
    eventSlugs: string[],
): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const unique = [...new Set(eventSlugs.filter(Boolean))];
    // gamma-api accepts a single slug per request; batch with limited concurrency.
    const CONCURRENCY = 8;
    let i = 0;
    async function worker() {
        while (i < unique.length) {
            const slug = unique[i++];
            if (!slug) continue;
            try {
                const res = await fetch(
                    `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`,
                );
                if (!res.ok) {
                    out.set(slug, []);
                    continue;
                }
                const arr = (await res.json()) as GammaEvent[];
                const ev = Array.isArray(arr) ? arr[0] : undefined;
                const labels = (ev?.tags ?? [])
                    .map((t) => t.label)
                    .filter((l): l is string => Boolean(l));
                out.set(slug, labels);
            } catch {
                out.set(slug, []);
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return out;
}

function pickCategory(tags: string[]): { name: string; weight: number } {
    for (const tag of tags) {
        for (const [key, weight] of Object.entries(CATEGORY_WEIGHTS)) {
            if (key.toLowerCase() === tag.toLowerCase()) {
                return { name: key, weight };
            }
        }
    }
    return { name: "Uncategorized", weight: DEFAULT_CATEGORY_WEIGHT };
}

function weightedVolumeForTrade(
    trade: Trade,
    categoryWeight: number,
    bonuses: number,
): { tradeSize: number; upside: number; wV: number } {
    // Symmetric for BUY/SELL: selling YES at p ≡ buying NO at (1−p).
    // tradeSize × upside collapses to size × price × (1 − price) either way.
    const tradeSize =
        trade.side === "BUY"
            ? trade.size * trade.price
            : trade.size * (1 - trade.price);
    const upside = trade.side === "BUY" ? 1 - trade.price : trade.price;
    const wV = tradeSize * upside * categoryWeight * bonuses;
    return { tradeSize, upside, wV };
}

function fmtUsd(n: number): string {
    return n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
    });
}

interface WalletReport {
    wallet: string;
    trades: number;
    totalSizeUsd: number;
    totalWeightedVolume: number;
    window: { sizeUsd: number; weightedVolume: number };
    byCategory: Record<string, { wV: number; size: number; count: number }>;
    byCategoryWindow: Record<
        string,
        { wV: number; size: number; count: number }
    >;
    earliestTradeTs: number | null;
    isEarlyUser: boolean;
}

async function reportForWallet(
    wallet: string,
    windowDays: number,
    quiet: boolean,
): Promise<WalletReport> {
    if (!quiet) console.error(`Fetching trades for ${wallet}…`);
    const trades = await fetchAllTrades(wallet);
    if (!quiet) console.error(`  → ${trades.length} taker trade(s).`);

    const tagsBySlug =
        trades.length > 0
            ? await fetchEventTags(trades.map((t) => t.eventSlug))
            : new Map<string, string[]>();

    const now = Math.floor(Date.now() / 1000);
    const windowStart = windowDays ? now - windowDays * 86_400 : 0;

    let totalWV = 0;
    let totalWVWindow = 0;
    let totalSize = 0;
    let totalSizeWindow = 0;
    let earliestTradeTs: number | null = null;
    const byCategory = new Map<
        string,
        { wV: number; size: number; count: number }
    >();
    const byCategoryWindow = new Map<
        string,
        { wV: number; size: number; count: number }
    >();

    for (const trade of trades) {
        if (earliestTradeTs === null || trade.timestamp < earliestTradeTs) {
            earliestTradeTs = trade.timestamp;
        }
        const tags = tagsBySlug.get(trade.eventSlug) ?? [];
        const cat = pickCategory(tags);
        const { tradeSize, wV } = weightedVolumeForTrade(
            trade,
            cat.weight,
            BONUSES,
        );

        totalWV += wV;
        totalSize += tradeSize;
        const agg = byCategory.get(cat.name) ?? { wV: 0, size: 0, count: 0 };
        agg.wV += wV;
        agg.size += tradeSize;
        agg.count += 1;
        byCategory.set(cat.name, agg);

        if (trade.timestamp >= windowStart) {
            totalWVWindow += wV;
            totalSizeWindow += tradeSize;
            const aggW = byCategoryWindow.get(cat.name) ?? {
                wV: 0,
                size: 0,
                count: 0,
            };
            aggW.wV += wV;
            aggW.size += tradeSize;
            aggW.count += 1;
            byCategoryWindow.set(cat.name, aggW);
        }
    }

    return {
        wallet,
        trades: trades.length,
        totalSizeUsd: totalSize,
        totalWeightedVolume: totalWV,
        window: { sizeUsd: totalSizeWindow, weightedVolume: totalWVWindow },
        byCategory: Object.fromEntries(byCategory),
        byCategoryWindow: Object.fromEntries(byCategoryWindow),
        earliestTradeTs,
        isEarlyUser:
            earliestTradeTs !== null && earliestTradeTs < EARLY_USER_CUTOFF,
    };
}

interface AllocationEstimate {
    scenario: string;
    proRataUsd: number;
    proRataWithBoostsUsd: number;
    hyperliquidComparableUsd: number;
    centerUsd: number;
    inputs: AllocationScenario & {
        userWv30dUsd: number;
        userAllTimeWvUsd: number;
        boost: number;
        isEarlyUser: boolean;
        assumedProfitable: boolean;
    };
}

function estimateAllocation(
    userWv30d: number,
    userWvAllTime: number,
    isEarlyUser: boolean,
    assumedProfitable: boolean,
    scenarios: AllocationScenario[] = ALLOCATION_SCENARIOS,
): AllocationEstimate[] {
    const boost =
        (isEarlyUser ? EARLY_USER_BOOST : 1) *
        (assumedProfitable ? PROFITABLE_TRADER_BOOST : 1);

    return scenarios.map((s) => {
        const airdropPoolUsd =
            s.fdvUsd * s.airdropPctOfSupply * s.traderShareOfAirdrop;

        // Methodology A: pro-rata of the trader pool by your share of
        // platform wV in the 30-day window.
        const userShare = userWv30d / s.platformWv30dUsd;
        const proRataUsd = userShare * airdropPoolUsd;
        const proRataWithBoostsUsd = proRataUsd * boost;

        // Methodology B: Hyperliquid-comparable per-$wV implied rate,
        // applied to your all-time wV (HYPE was based on cumulative pre-
        // launch volume, not a 30-day window — so use all-time here).
        const hyperliquidComparableUsd =
            userWvAllTime * s.hyperliquidUsdPerWv * boost;

        // Centerpoint = mean of A-with-boosts and B for the scenario.
        const centerUsd = (proRataWithBoostsUsd + hyperliquidComparableUsd) / 2;

        return {
            scenario: s.name,
            proRataUsd,
            proRataWithBoostsUsd,
            hyperliquidComparableUsd,
            centerUsd,
            inputs: {
                ...s,
                userWv30dUsd: userWv30d,
                userAllTimeWvUsd: userWvAllTime,
                boost,
                isEarlyUser,
                assumedProfitable,
            },
        };
    });
}

function printAllocationEstimates(
    estimates: AllocationEstimate[],
    isEarlyUser: boolean,
    assumedProfitable: boolean,
) {
    console.log(`\n=== Airdrop allocation estimate ===`);
    console.log(
        `  Boosts applied: early-user=${isEarlyUser ? "yes ×1.5" : "no"}, ` +
            `profitable=${assumedProfitable ? "yes ×1.25" : "no"} ` +
            `(use --profitable to apply the profitable-trader boost)`,
    );
    console.log(
        `\n  Scenario   Pro-rata (no boost)   Pro-rata (boosted)   ` +
            `HL-comparable   Centerpoint`,
    );
    for (const e of estimates) {
        console.log(
            `  ${e.scenario.padEnd(10)} ${fmtUsd(e.proRataUsd).padStart(18)}   ` +
                `${fmtUsd(e.proRataWithBoostsUsd).padStart(18)}   ` +
                `${fmtUsd(e.hyperliquidComparableUsd).padStart(13)}   ` +
                `${fmtUsd(e.centerUsd).padStart(11)}`,
        );
    }
    console.log(
        `\n  Methodology:\n` +
            `   A. Pro-rata trader share: user_wV_30d / platform_wV_30d × (FDV × airdrop% × trader%)\n` +
            `   B. Hyperliquid-comparable: user_wV_all_time × implied_$/wV_rate (from HYPE airdrop)\n` +
            `   Centerpoint averages A-with-boosts and B for each scenario.\n` +
            `\n  All inputs (FDV, airdrop %, platform wV) are public-guess assumptions.\n` +
            `  Adjust ALLOCATION_SCENARIOS in the script to tune.`,
    );
}

function printWalletReport(r: WalletReport, windowDays: number) {
    console.log(`\nWallet: ${r.wallet}`);
    console.log(`Taker trades: ${r.trades}`);
    if (r.trades === 0) {
        console.log("  (no taker trades found)");
        return;
    }
    console.log(`\n— All time —`);
    console.log(`  Trade size (USD):        ${fmtUsd(r.totalSizeUsd)}`);
    console.log(`  Weighted volume (wV):    ${fmtUsd(r.totalWeightedVolume)}`);
    console.log(`\n— Last ${windowDays} day(s) (tier window) —`);
    console.log(`  Trade size (USD):        ${fmtUsd(r.window.sizeUsd)}`);
    console.log(
        `  Weighted volume (wV):    ${fmtUsd(r.window.weightedVolume)}`,
    );

    const rows = Object.entries(r.byCategoryWindow)
        .sort((a, b) => b[1].wV - a[1].wV)
        .map(
            ([cat, v]) =>
                `  ${cat.padEnd(18)} count=${String(v.count).padStart(4)}  size=${fmtUsd(v.size).padStart(12)}  wV=${fmtUsd(v.wV).padStart(12)}`,
        );
    if (rows.length) {
        console.log(`\n— Window breakdown by category —`);
        console.log(rows.join("\n"));
    }
}

async function main() {
    const { wallets, windowDays, json, profitable } = parseArgs(process.argv);

    const reports: WalletReport[] = [];
    for (const wallet of wallets) {
        reports.push(await reportForWallet(wallet, windowDays, json));
    }

    const combinedWv30d = reports.reduce(
        (s, r) => s + r.window.weightedVolume,
        0,
    );
    const combinedWvAllTime = reports.reduce(
        (s, r) => s + r.totalWeightedVolume,
        0,
    );
    const anyEarly = reports.some((r) => r.isEarlyUser);
    const estimates = estimateAllocation(
        combinedWv30d,
        combinedWvAllTime,
        anyEarly,
        profitable,
    );

    if (json) {
        const combined = reports.reduce(
            (acc, r) => ({
                trades: acc.trades + r.trades,
                totalSizeUsd: acc.totalSizeUsd + r.totalSizeUsd,
                totalWeightedVolume:
                    acc.totalWeightedVolume + r.totalWeightedVolume,
                window: {
                    sizeUsd: acc.window.sizeUsd + r.window.sizeUsd,
                    weightedVolume:
                        acc.window.weightedVolume + r.window.weightedVolume,
                },
            }),
            {
                trades: 0,
                totalSizeUsd: 0,
                totalWeightedVolume: 0,
                window: { sizeUsd: 0, weightedVolume: 0 },
            },
        );
        console.log(
            JSON.stringify(
                {
                    windowDays,
                    wallets: reports,
                    combined,
                    allocationEstimates: estimates,
                    notes: [
                        "Category weights and bonus multipliers default to 1.0.",
                        "Replace CATEGORY_WEIGHTS / BONUSES in the script once Polymarket publishes the official table.",
                        "Allocation estimates use public-guess assumptions; tune ALLOCATION_SCENARIOS.",
                    ],
                },
                null,
                2,
            ),
        );
        return;
    }

    for (const r of reports) printWalletReport(r, windowDays);

    if (reports.length > 1) {
        const combinedSize = reports.reduce((s, r) => s + r.window.sizeUsd, 0);
        const combinedAllSize = reports.reduce((s, r) => s + r.totalSizeUsd, 0);
        console.log(`\n=== Combined across ${reports.length} wallets ===`);
        console.log(`  All-time size:           ${fmtUsd(combinedAllSize)}`);
        console.log(`  All-time wV:             ${fmtUsd(combinedWvAllTime)}`);
        console.log(
            `  Window size (${windowDays}d):       ${fmtUsd(combinedSize)}`,
        );
        console.log(
            `  Window wV (${windowDays}d):         ${fmtUsd(combinedWv30d)}`,
        );
    }

    const earliestPerWallet = reports
        .filter((r) => r.earliestTradeTs !== null)
        .map(
            (r) =>
                `    ${r.wallet}: ${new Date((r.earliestTradeTs as number) * 1000).toISOString().slice(0, 10)}${r.isEarlyUser ? " (pre-2025 → early-user boost)" : ""}`,
        );
    if (earliestPerWallet.length) {
        console.log(`\n— Earliest taker trade per wallet —`);
        console.log(earliestPerWallet.join("\n"));
    }

    printAllocationEstimates(estimates, anyEarly, profitable);

    console.log(
        `\nNote: category weights and bonuses default to 1.0. Edit CATEGORY_WEIGHTS\n` +
            `and BONUSES in this script once Polymarket publishes the official table.\n` +
            `Reminder: Polymarket caps the tier calculation at the last 30 days of taker volume.`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
