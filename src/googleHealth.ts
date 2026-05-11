import crypto from "node:crypto";
import { getSupabase } from "./supabase.js";

// =============================================================================
// Google Health API integration (Fitbit Air / Google Health app)
//
// Reference: https://developers.google.com/health
// Base URL:  https://health.googleapis.com/v4
//
// Scopes are RESTRICTED in Google's terminology — production use needs a
// privacy + security review. For a single-user personal MCP we run in test
// mode with the user's email as a test user. Refresh tokens last ~7 days in
// test mode, so re-auth is occasionally required (the `google_health_status`
// tool surfaces this).
// =============================================================================

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GHEALTH_BASE_URL = "https://health.googleapis.com/v4";

// All currently-documented data type identifiers, grouped by scope.
// See https://developers.google.com/health/data-types
export const GOOGLE_HEALTH_DATA_TYPES = {
    activity_and_fitness: [
        "active-minutes",
        "active-zone-minutes",
        "activity-level",
        "altitude",
        "calories-in-heart-rate-zone",
        "daily-vo2-max",
        "distance",
        "exercise",
        "floors",
        "run-vo2-max",
        "sedentary-period",
        "steps",
        "swim-lengths-data",
        "time-in-heart-rate-zone",
        "total-calories",
        "vo2-max",
    ],
    health_metrics_and_measurements: [
        "body-fat",
        "daily-heart-rate-variability",
        "daily-heart-rate-zones",
        "daily-oxygen-saturation",
        "daily-respiratory-rate",
        "daily-resting-heart-rate",
        "daily-sleep-temperature-derivations",
        "heart-rate",
        "heart-rate-variability",
        "height",
        "oxygen-saturation",
        "respiratory-rate-sleep-summary",
        "weight",
    ],
    sleep: ["sleep"],
    nutrition: ["hydration-log"],
} as const;

export type DataTypeCategory = keyof typeof GOOGLE_HEALTH_DATA_TYPES;

// Read-only scopes — we ingest, we don't push.
const SCOPES = [
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    "https://www.googleapis.com/auth/googlehealth.nutrition.readonly",
];

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------- Helpers ----------

function requireGoogleClientCreds(): { id: string; secret: string } {
    const id = process.env.GOOGLE_HEALTH_CLIENT_ID;
    const secret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
    if (!id || !secret) {
        throw new Error(
            "Google Health is not configured. Set GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_CLIENT_SECRET in the server environment.",
        );
    }
    return { id, secret };
}

function getCallbackUrl(): string {
    const base =
        process.env.PUBLIC_BASE_URL ?? "https://nutrition-mcp-production-8ba9.up.railway.app";
    return `${base.replace(/\/$/, "")}/google-health/callback`;
}

function base64URLEncode(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}

function sha256Base64Url(input: string): string {
    return base64URLEncode(crypto.createHash("sha256").update(input).digest());
}

// ---------- OAuth state (CSRF protection) ----------

export async function createAuthorizeUrl(userId: string): Promise<string> {
    const { id } = requireGoogleClientCreds();

    // PKCE — the verifier never leaves our DB until /token exchange. The
    // challenge goes to Google.
    const state = crypto.randomUUID();
    const codeVerifier = base64URLEncode(crypto.randomBytes(32));
    const codeChallenge = sha256Base64Url(codeVerifier);
    const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

    const { error } = await getSupabase()
        .from("google_health_oauth_states")
        .insert({
            state,
            user_id: userId,
            code_verifier: codeVerifier,
            expires_at: expiresAt,
        });

    if (error)
        throw new Error(`Failed to persist OAuth state: ${error.message}`);

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", id);
    url.searchParams.set("redirect_uri", getCallbackUrl());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
}

interface ConsumedState {
    user_id: string;
    code_verifier: string;
}

export async function consumeOAuthState(
    state: string,
): Promise<ConsumedState | null> {
    const now = new Date().toISOString();
    const { data, error } = await getSupabase()
        .from("google_health_oauth_states")
        .delete()
        .eq("state", state)
        .gt("expires_at", now)
        .select()
        .single();

    if (error || !data) return null;
    return {
        user_id: (data as { user_id: string }).user_id,
        code_verifier: (data as { code_verifier: string }).code_verifier,
    };
}

// ---------- Token exchange ----------

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    token_type: string;
}

export async function exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
): Promise<TokenResponse> {
    const { id, secret } = requireGoogleClientCreds();

    const body = new URLSearchParams({
        code,
        client_id: id,
        client_secret: secret,
        redirect_uri: getCallbackUrl(),
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Google token exchange failed: ${errText}`);
    }
    return (await res.json()) as TokenResponse;
}

async function refreshAccessToken(
    refreshToken: string,
): Promise<TokenResponse> {
    const { id, secret } = requireGoogleClientCreds();

    const body = new URLSearchParams({
        client_id: id,
        client_secret: secret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(
            `Google token refresh failed (re-auth may be needed): ${errText}`,
        );
    }
    return (await res.json()) as TokenResponse;
}

// ---------- Token storage ----------

export interface StoredGoogleHealthTokens {
    user_id: string;
    access_token: string;
    refresh_token: string | null;
    expires_at: string;
    scopes: string[];
    google_user_id: string | null;
    legacy_fitbit_user_id: string | null;
    created_at: string;
    updated_at: string;
}

export async function saveTokens(
    userId: string,
    tokens: TokenResponse,
    identity?: { googleUserId?: string; legacyFitbitUserId?: string },
): Promise<StoredGoogleHealthTokens> {
    const expiresAt = new Date(
        Date.now() + tokens.expires_in * 1000,
    ).toISOString();
    const scopes = tokens.scope ? tokens.scope.split(" ") : SCOPES;

    const payload: Record<string, unknown> = {
        user_id: userId,
        access_token: tokens.access_token,
        expires_at: expiresAt,
        scopes,
        updated_at: new Date().toISOString(),
    };
    if (tokens.refresh_token) payload.refresh_token = tokens.refresh_token;
    if (identity?.googleUserId) payload.google_user_id = identity.googleUserId;
    if (identity?.legacyFitbitUserId)
        payload.legacy_fitbit_user_id = identity.legacyFitbitUserId;

    const { data, error } = await getSupabase()
        .from("google_health_tokens")
        .upsert(payload, { onConflict: "user_id" })
        .select()
        .single();

    if (error)
        throw new Error(`Failed to save Google Health tokens: ${error.message}`);
    return data as StoredGoogleHealthTokens;
}

export async function getStoredTokens(
    userId: string,
): Promise<StoredGoogleHealthTokens | null> {
    const { data, error } = await getSupabase()
        .from("google_health_tokens")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

    if (error)
        throw new Error(`Failed to load Google Health tokens: ${error.message}`);
    return (data as StoredGoogleHealthTokens | null) ?? null;
}

export async function deleteStoredTokens(userId: string): Promise<void> {
    const sb = getSupabase();
    const { error } = await sb
        .from("google_health_tokens")
        .delete()
        .eq("user_id", userId);
    if (error)
        throw new Error(
            `Failed to delete Google Health tokens: ${error.message}`,
        );
}

async function getValidAccessToken(userId: string): Promise<string> {
    const stored = await getStoredTokens(userId);
    if (!stored) {
        throw new Error(
            "Google Health is not connected for this user. Call google_health_connect to start the OAuth flow.",
        );
    }

    const expiry = new Date(stored.expires_at).getTime();
    // Refresh slightly before expiry to avoid mid-request 401s.
    if (expiry - Date.now() > 60_000) return stored.access_token;

    if (!stored.refresh_token) {
        throw new Error(
            "Access token expired and no refresh token is stored. Re-run google_health_connect.",
        );
    }
    const refreshed = await refreshAccessToken(stored.refresh_token);
    await saveTokens(userId, {
        ...refreshed,
        // Google returns a refresh_token only on the first exchange most of
        // the time — fall back to the existing one if missing.
        refresh_token: refreshed.refresh_token ?? stored.refresh_token,
    });
    return refreshed.access_token;
}

// ---------- API client ----------

async function ghealthFetch<T>(
    userId: string,
    path: string,
    init: RequestInit = {},
): Promise<T> {
    const accessToken = await getValidAccessToken(userId);
    const res = await fetch(`${GHEALTH_BASE_URL}${path}`, {
        ...init,
        headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
        },
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(
            `Google Health API error ${res.status} on ${path}: ${errText}`,
        );
    }
    return (await res.json()) as T;
}

export async function fetchIdentity(userId: string): Promise<{
    googleUserId?: string;
    legacyFitbitUserId?: string;
}> {
    const data = await ghealthFetch<{
        healthUserId?: string;
        legacyUserId?: string;
    }>(userId, "/users/me/identity");
    return {
        googleUserId: data.healthUserId,
        legacyFitbitUserId: data.legacyUserId,
    };
}

interface RawDataPoint {
    dataPointId?: string;
    id?: string;
    startTime?: string;
    endTime?: string;
    [key: string]: unknown;
}

interface DataPointsResponse {
    dataPoints?: RawDataPoint[];
    nextPageToken?: string;
}

export async function listDataPoints(
    userId: string,
    dataType: string,
    opts: {
        startTime?: string; // ISO 8601
        endTime?: string; // ISO 8601
        pageSize?: number;
        pageToken?: string;
    } = {},
): Promise<DataPointsResponse> {
    const params = new URLSearchParams();
    if (opts.startTime) params.set("startTime", opts.startTime);
    if (opts.endTime) params.set("endTime", opts.endTime);
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    if (opts.pageToken) params.set("pageToken", opts.pageToken);

    const qs = params.toString();
    return ghealthFetch<DataPointsResponse>(
        userId,
        `/users/me/dataTypes/${dataType}/dataPoints${qs ? `?${qs}` : ""}`,
    );
}

// ---------- Sync to Supabase ----------

export interface SyncResult {
    dataType: string;
    inserted: number;
    skipped: number;
    error?: string;
}

export async function syncDataType(
    userId: string,
    dataType: string,
    opts: { startTime: string; endTime: string },
): Promise<SyncResult> {
    const sb = getSupabase();
    let inserted = 0;
    let skipped = 0;
    let pageToken: string | undefined;

    try {
        do {
            const page: DataPointsResponse = await listDataPoints(
                userId,
                dataType,
                { ...opts, pageSize: 100, pageToken },
            );

            const points = page.dataPoints ?? [];
            for (const dp of points) {
                const pointId = dp.dataPointId ?? dp.id;
                const start = dp.startTime ?? null;
                if (!pointId || !start) {
                    skipped++;
                    continue;
                }
                const { error } = await sb
                    .from("google_health_data_points")
                    .upsert(
                        {
                            user_id: userId,
                            data_type: dataType,
                            point_id: pointId,
                            start_time: start,
                            end_time: dp.endTime ?? null,
                            value: dp,
                            source: dp.source ?? null,
                        },
                        {
                            onConflict: "user_id,data_type,point_id",
                            ignoreDuplicates: false,
                        },
                    );
                if (error) {
                    skipped++;
                    continue;
                }
                inserted++;
            }
            pageToken = page.nextPageToken;
        } while (pageToken);

        await sb.from("google_health_sync_state").upsert(
            {
                user_id: userId,
                data_type: dataType,
                last_synced_through: opts.endTime,
                last_attempt_at: new Date().toISOString(),
                last_error: null,
            },
            { onConflict: "user_id,data_type" },
        );

        return { dataType, inserted, skipped };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sb.from("google_health_sync_state").upsert(
            {
                user_id: userId,
                data_type: dataType,
                last_attempt_at: new Date().toISOString(),
                last_error: message,
            },
            { onConflict: "user_id,data_type" },
        );
        return { dataType, inserted, skipped, error: message };
    }
}

// ---------- Read stored data ----------

export interface StoredDataPoint {
    id: string;
    user_id: string;
    data_type: string;
    point_id: string;
    start_time: string;
    end_time: string | null;
    value: Record<string, unknown>;
    source: Record<string, unknown> | null;
    fetched_at: string;
}

export async function queryStoredDataPoints(
    userId: string,
    dataType: string,
    startTime: string,
    endTime: string,
    limit = 200,
): Promise<StoredDataPoint[]> {
    const { data, error } = await getSupabase()
        .from("google_health_data_points")
        .select("*")
        .eq("user_id", userId)
        .eq("data_type", dataType)
        .gte("start_time", startTime)
        .lte("start_time", endTime)
        .order("start_time", { ascending: true })
        .limit(limit);

    if (error)
        throw new Error(`Failed to query data points: ${error.message}`);
    return (data as StoredDataPoint[]) ?? [];
}

export interface SyncStateRow {
    user_id: string;
    data_type: string;
    last_synced_through: string | null;
    last_attempt_at: string | null;
    last_error: string | null;
}

export async function getSyncState(
    userId: string,
): Promise<SyncStateRow[]> {
    const { data, error } = await getSupabase()
        .from("google_health_sync_state")
        .select("*")
        .eq("user_id", userId)
        .order("data_type", { ascending: true });

    if (error)
        throw new Error(`Failed to load sync state: ${error.message}`);
    return (data as SyncStateRow[]) ?? [];
}

// ---------- Disconnect ----------

export async function revokeAndDisconnect(userId: string): Promise<void> {
    const stored = await getStoredTokens(userId);
    if (stored?.refresh_token) {
        // Best-effort revoke — even if Google rejects this we still drop the
        // local row to fully disconnect.
        await fetch(`${GOOGLE_REVOKE_URL}?token=${stored.refresh_token}`, {
            method: "POST",
        }).catch(() => undefined);
    }
    await deleteStoredTokens(userId);

    const sb = getSupabase();
    await sb
        .from("google_health_oauth_states")
        .delete()
        .eq("user_id", userId);
}

// ---------- Cleanup hook for delete_account ----------

export async function deleteAllGoogleHealthData(
    userId: string,
): Promise<void> {
    const sb = getSupabase();

    const { error: dpErr } = await sb
        .from("google_health_data_points")
        .delete()
        .eq("user_id", userId);
    if (dpErr)
        throw new Error(`Failed to delete data points: ${dpErr.message}`);

    const { error: ssErr } = await sb
        .from("google_health_sync_state")
        .delete()
        .eq("user_id", userId);
    if (ssErr)
        throw new Error(`Failed to delete sync state: ${ssErr.message}`);

    const { error: stErr } = await sb
        .from("google_health_oauth_states")
        .delete()
        .eq("user_id", userId);
    if (stErr)
        throw new Error(`Failed to delete OAuth states: ${stErr.message}`);

    const { error: tokErr } = await sb
        .from("google_health_tokens")
        .delete()
        .eq("user_id", userId);
    if (tokErr)
        throw new Error(`Failed to delete tokens: ${tokErr.message}`);
}
