/** The slice of SupabaseClient the repositories actually use. Repos take
 *  this narrow type rather than the full SupabaseClient, so both the real
 *  client and a test fake can satisfy it. */

export interface QueryResult<T = unknown> {
  data: T | null;
  // Left as `unknown` rather than a Postgrest error shape: toPersistError
  // (persistError.ts) is what classifies it, and it already accepts
  // `unknown`. Typing it narrower here would just force a cast at every
  // call site for no benefit.
  error: unknown;
}

/** A chainable query builder — the shape supabase-js hands back from
 *  `.from(table)`, narrowed to the methods repositories call. Each method
 *  returns the same shape so calls compose, and the builder itself is
 *  awaitable, resolving to a QueryResult (matching supabase-js's own
 *  PostgrestBuilder, which is a thenable rather than a Promise). */
export interface QueryBuilder {
  select(columns?: string): QueryBuilder;
  insert(payload: unknown): QueryBuilder;
  upsert(payload: unknown, options?: { onConflict?: string }): QueryBuilder;
  update(payload: unknown): QueryBuilder;
  delete(): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  in(column: string, value: unknown): QueryBuilder;
  is(column: string, value: unknown): QueryBuilder;
  order(column: string, options?: { ascending?: boolean }): QueryBuilder;
  limit(count: number): QueryBuilder;
  /** Inclusive row window, both ends. The only way to read past PostgREST's
   *  per-request row cap, which truncates silently. */
  range(from: number, to: number): QueryBuilder;
  single(): QueryBuilder;
  maybeSingle(): QueryBuilder;
  // Deliberately not generic (unlike PromiseLike<T>.then): the recording
  // fake's `.then` (fakeSupabase.ts) has this same fixed shape, and a
  // generic signature here does not structurally match a concrete one.
  // `await` only needs the first callback's parameter type to infer the
  // resolved type, so this is enough to make `await client.from(...)...`
  // resolve to QueryResult.
  then(onFulfilled?: (result: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown): Promise<unknown>;
}

export interface QueryClient {
  from(table: string): QueryBuilder;
}
