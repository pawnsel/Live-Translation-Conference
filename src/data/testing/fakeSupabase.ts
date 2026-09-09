/** A recording stand-in for the Supabase query builder.
 *
 *  Repo tests care about which statement was issued — table, operation,
 *  payload, filters — not about Postgres. This records exactly that and hands
 *  back queued results, so a repo can be tested in milliseconds without a
 *  database. It is a test double, never imported by application code.
 */

export interface RecordedFilter {
  kind: 'eq' | 'in' | 'is' | 'order' | 'limit';
  column: string;
  value: unknown;
}

export interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown;
  columns?: string;
  filters: RecordedFilter[];
  /** True when the caller asked for one row (.single() / .maybeSingle()). */
  single: boolean;
}

export interface FakeResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

export function createFakeSupabase(results: FakeResult[] = []) {
  const calls: RecordedCall[] = [];
  const queue: FakeResult[] = [...results];

  function build(call: RecordedCall) {
    const chain = {
      // Does NOT set `op`: a trailing .select() after .insert() is how
      // supabase-js asks for the written row back, not a new statement.
      select(columns?: string) {
        call.columns = columns ?? '*';
        return chain;
      },
      insert(payload: unknown) {
        call.op = 'insert';
        call.payload = payload;
        return chain;
      },
      upsert(payload: unknown, _options?: unknown) {
        call.op = 'upsert';
        call.payload = payload;
        return chain;
      },
      update(payload: unknown) {
        call.op = 'update';
        call.payload = payload;
        return chain;
      },
      delete() {
        call.op = 'delete';
        return chain;
      },
      eq(column: string, value: unknown) {
        call.filters.push({ kind: 'eq', column, value });
        return chain;
      },
      is(column: string, value: unknown) {
        call.filters.push({ kind: 'is', column, value });
        return chain;
      },
      in(column: string, value: unknown) {
        call.filters.push({ kind: 'in', column, value });
        return chain;
      },
      order(column: string, options?: unknown) {
        call.filters.push({ kind: 'order', column, value: options });
        return chain;
      },
      limit(count: number) {
        call.filters.push({ kind: 'limit', column: '', value: count });
        return chain;
      },
      single() {
        call.single = true;
        return chain;
      },
      maybeSingle() {
        call.single = true;
        return chain;
      },
      // Thenable, so `await` on the chain resolves like a real query.
      then(
        onFulfilled?: (result: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) {
        const next = queue.shift() ?? {};
        return Promise.resolve({
          data: next.data ?? null,
          error: next.error ?? null
        }).then(onFulfilled, onRejected);
      }
    };
    return chain;
  }

  return {
    client: {
      from(table: string) {
        const call: RecordedCall = { table, op: 'select', filters: [], single: false };
        calls.push(call);
        return build(call);
      }
    },
    calls,
    /** Queue more results for statements issued later in the same test. */
    queueResults(...next: FakeResult[]) {
      queue.push(...next);
    }
  };
}
