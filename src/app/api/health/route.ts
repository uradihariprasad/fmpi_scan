import { pool, databaseConnectionInfo } from "@/db";
import { ensureSchema } from "@/db/bootstrap";
import { databaseStatus, describeDbError, markDbFailure, markDbSuccess } from "@/db/status";

export const dynamic = "force-dynamic";

/**
 * Render liveness/readiness endpoint.
 *
 * PostgreSQL is persistence/cache, not the market-data source. A DB outage
 * therefore returns HTTP 200 with `database.status = degraded`; genuine
 * Upstox data remains available through direct fallback and Render must not
 * restart-loop the service. Diagnostics contain no credentials.
 */
export async function GET() {
  const configured = Boolean(process.env.DATABASE_URL);
  const connection = configured
    ? databaseConnectionInfo(process.env.DATABASE_URL as string)
    : { configured: false, host: null, port: null, database: null, ssl: false, renderInternal: false };

  try {
    const result = await pool.query<{ now: Date }>("select now() as now");
    await ensureSchema();
    markDbSuccess();
    return Response.json({
      ok: true,
      marketData: { status: "available", source: "Upstox" },
      database: {
        status: "connected",
        host: connection.host,
        database: connection.database,
        ssl: connection.ssl,
        renderInternal: connection.renderInternal,
        serverTime: result.rows[0]?.now ?? null,
      },
    });
  } catch (e) {
    markDbFailure(e);
    return Response.json({
      // App is alive and can serve real candles directly from Upstox.
      ok: true,
      degraded: true,
      marketData: {
        status: "available",
        source: "Upstox direct fallback",
        persistence: "temporarily unavailable",
      },
      database: {
        status: "degraded",
        host: connection.host,
        database: connection.database,
        ssl: connection.ssl,
        renderInternal: connection.renderInternal,
        error: describeDbError(e),
        circuit: databaseStatus(),
        guidance:
          "On Render use fromDatabase.connectionString in the same region. Internal dpg-* hosts must not force SSL; external *-postgres.render.com hosts require SSL.",
      },
    });
  }
}
