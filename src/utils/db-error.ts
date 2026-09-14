import { SQL } from "bun";

/**
 * The Postgres error behind a failed query, or undefined if it wasn't one.
 *
 * drizzle-orm's bun-sql adapter always wraps driver errors in its own
 * DrizzleQueryError, with the real SQL.PostgresError as `.cause` — so check
 * that instead of the thrown error itself. On SQL.PostgresError, the
 * Postgres SQLSTATE (e.g. "23505" unique violation, "23503" foreign key
 * violation) is `.errno`; `.code` is Bun's own wrapper code
 * ("ERR_POSTGRES_SERVER_ERROR"), not the SQLSTATE.
 */
export function postgresError(error: unknown): SQL.PostgresError | undefined {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  return cause instanceof SQL.PostgresError ? cause : undefined;
}
