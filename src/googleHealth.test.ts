import { test, expect } from "bun:test";
import {
    extractPointStartTime,
    extractPointEndTime,
    getTypePayload,
} from "./googleHealth.js";

// Payload shapes below are verbatim from the live Google Health API v4
// (google_health_inspect_raw, 2026-07-01). The key regression this guards:
// payloads nest under the camelCase data type ID, not snake_case.

test("interval type under camelCase key (active-minutes)", () => {
    const dp = {
        dataSource: { recordingMethod: "DERIVED", platform: "FITBIT" },
        activeMinutes: {
            interval: {
                startTime: "2026-07-01T21:03:00Z",
                startUtcOffset: "0s",
                endTime: "2026-07-01T21:04:00Z",
                endUtcOffset: "0s",
                civilStartTime: {
                    date: { year: 2026, month: 7, day: 1 },
                    time: { hours: 21, minutes: 3 },
                },
            },
            activeMinutesByActivityLevel: [
                { activityLevel: "LIGHT", activeMinutes: "1" },
            ],
        },
    };
    expect(extractPointStartTime(dp, "active-minutes")).toBe(
        "2026-07-01T21:03:00.000Z",
    );
    expect(extractPointEndTime(dp, "active-minutes")).toBe(
        "2026-07-01T21:04:00.000Z",
    );
});

test("sample type with physicalTime (heart-rate)", () => {
    const dp = {
        dataSource: {
            recordingMethod: "PASSIVELY_MEASURED",
            platform: "FITBIT",
        },
        heartRate: {
            sampleTime: {
                physicalTime: "2026-07-01T21:03:32Z",
                utcOffset: "-14400s",
                civilTime: {
                    date: { year: 2026, month: 7, day: 1 },
                    time: { hours: 17, minutes: 3, seconds: 32 },
                },
            },
            beatsPerMinute: "101",
        },
    };
    // Must pick the UTC physicalTime, NOT the local civilTime.
    expect(extractPointStartTime(dp, "heart-rate")).toBe(
        "2026-07-01T21:03:32.000Z",
    );
});

test("daily type with civil date object (daily-resting-heart-rate)", () => {
    const dp = {
        dataSource: { recordingMethod: "DERIVED", platform: "FITBIT" },
        dailyRestingHeartRate: {
            date: { year: 2026, month: 7, day: 1 },
            beatsPerMinute: "68",
            dailyRestingHeartRateMetadata: { calculationMethod: "WITH_SLEEP" },
        },
    };
    expect(extractPointStartTime(dp, "daily-resting-heart-rate")).toBe(
        "2026-07-01T00:00:00Z",
    );
    expect(extractPointEndTime(dp, "daily-resting-heart-rate")).toBeNull();
});

test("multi-word daily type (daily-heart-rate-variability)", () => {
    const dp = {
        dailyHeartRateVariability: {
            date: { year: 2026, month: 6, day: 9 },
            averageHeartRateVariabilityMilliseconds: 42.7,
        },
    };
    expect(extractPointStartTime(dp, "daily-heart-rate-variability")).toBe(
        "2026-06-09T00:00:00Z",
    );
});

test("interval type with named point (exercise)", () => {
    const dp = {
        name: "users/386.../dataTypes/exercise/dataPoints/780...",
        exercise: {
            interval: {
                startTime: "2026-07-01T19:49:37.708Z",
                endTime: "2026-07-01T20:17:07.018Z",
            },
            exerciseType: "WALKING",
        },
    };
    expect(extractPointStartTime(dp, "exercise")).toBe(
        "2026-07-01T19:49:37.708Z",
    );
    expect(extractPointEndTime(dp, "exercise")).toBe(
        "2026-07-01T20:17:07.018Z",
    );
});

test("single-word types still resolve (steps regression guard)", () => {
    const dp = {
        steps: {
            interval: {
                startTime: "2026-07-01T10:00:00Z",
                endTime: "2026-07-01T10:01:00Z",
            },
            count: 42,
        },
    };
    expect(getTypePayload(dp, "steps")).toBeDefined();
    expect(extractPointStartTime(dp, "steps")).toBe("2026-07-01T10:00:00.000Z");
});

test("civil fallback used only when no UTC field exists", () => {
    const dp = {
        activeMinutes: {
            interval: {
                civilStartTime: {
                    date: { year: 2026, month: 7, day: 1 },
                    time: { hours: 21, minutes: 3 },
                },
            },
        },
    };
    expect(extractPointStartTime(dp, "active-minutes")).toBe(
        "2026-07-01T21:03:00Z",
    );
});

test("unparseable point returns null", () => {
    expect(extractPointStartTime({}, "heart-rate")).toBeNull();
    expect(extractPointEndTime({}, "heart-rate")).toBeNull();
});
