# Nutrition MCP

A remote MCP (Model Context Protocol) server for personal nutrition tracking. Connect it to Claude.ai as a custom connector to log meals, track macros, and review nutrition history.

## Tech Stack

- **Bun** — runtime and package manager
- **Hono** — HTTP framework
- **MCP SDK** — Model Context Protocol over Streamable HTTP
- **Supabase** — PostgreSQL database + user authentication
- **OAuth 2.0** — authentication for Claude.ai connectors

## MCP Tools

| Tool                    | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `log_meal`              | Log a meal with description, type, calories, macros, notes |
| `get_meals_today`       | Get all meals logged today                                 |
| `get_meals_by_date`     | Get meals for a specific date (YYYY-MM-DD)                 |
| `get_nutrition_summary` | Daily nutrition totals for a date range                    |
| `delete_meal`           | Delete a meal by ID                                        |
| `update_meal`           | Update any fields of an existing meal                      |

## Connect to Claude.ai

1. Open [Claude.ai](https://claude.ai) and click **Customize**
2. Click **Connectors**, then the **+** button
3. Click **Add custom connector**
4. Fill in:
    - **Name**: Nutrition Tracker
    - **Remote MCP Server URL**: `https://nutrition-mcp.com/mcp`
5. Click **Connect** — sign in or register when prompted
6. After signing in, Claude can use your nutrition tools. If you reconnect later, sign in with the same email and password to keep your data.

## API Endpoints

| Endpoint                                      | Description                            |
| --------------------------------------------- | -------------------------------------- |
| `GET /health`                                 | Health check                           |
| `GET /.well-known/oauth-authorization-server` | OAuth metadata discovery               |
| `POST /register`                              | Dynamic client registration            |
| `GET /authorize`                              | OAuth authorization (shows login page) |
| `POST /approve`                               | Login/register handler                 |
| `POST /token`                                 | Token exchange                         |
| `GET /favicon.ico`                            | Server icon                            |
| `ALL /mcp`                                    | MCP endpoint (authenticated)           |
