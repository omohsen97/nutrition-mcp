import type { Context, Next } from "hono";
import { isTokenValid } from "./supabase.js";

export const authenticateBearer = async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json(
            {
                error: "unauthorized",
                error_description: "Bearer token required",
            },
            401,
        );
    }

    const token = authHeader.substring(7);
    const valid = await isTokenValid(token);

    if (!valid) {
        return c.json(
            {
                error: "invalid_token",
                error_description: "Token is invalid or expired",
            },
            401,
        );
    }

    c.set("accessToken", token);
    await next();
};
