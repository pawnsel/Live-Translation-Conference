/** The slice of SupabaseClient the repositories actually use. Repos take
 *  this narrow type rather than the full SupabaseClient, so both the real
 *  client and a test fake can satisfy it. */
export interface QueryClient {
  from(table: string): unknown;
}
