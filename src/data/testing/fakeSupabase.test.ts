import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from './fakeSupabase';

describe('createFakeSupabase', () => {
  it('records a select with its filters and returns the queued rows', async () => {
    const fake = createFakeSupabase([{ data: [{ id: 'a' }] }]);

    const { data } = await fake.client.from('projects').select('*').eq('owner_id', 'u1');

    expect(data).toEqual([{ id: 'a' }]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'select',
      columns: '*',
      filters: [{ kind: 'eq', column: 'owner_id', value: 'u1' }]
    });
  });

  // insert().select().single() must stay an insert — a trailing .select() is
  // how supabase-js asks for the inserted row back, not a second statement.
  it('keeps the operation as insert when select() follows it', async () => {
    const fake = createFakeSupabase([{ data: { id: 'new' } }]);

    const { data } = await fake.client
      .from('projects')
      .insert({ name: 'p' })
      .select()
      .single();

    expect(data).toEqual({ id: 'new' });
    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'insert',
      payload: { name: 'p' },
      single: true
    });
  });

  it('records updates with their payload and filters', async () => {
    const fake = createFakeSupabase([{ data: null }]);

    await fake.client
      .from('transcript_items')
      .update({ target_text: 'fixed', is_edited: true })
      .eq('session_id', 's1')
      .eq('seq', 4);

    expect(fake.calls[0]).toMatchObject({
      table: 'transcript_items',
      op: 'update',
      payload: { target_text: 'fixed', is_edited: true },
      filters: [
        { kind: 'eq', column: 'session_id', value: 's1' },
        { kind: 'eq', column: 'seq', value: 4 }
      ]
    });
  });

  it('records deletes', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await fake.client.from('glossary_terms').delete().eq('id', 't1');
    expect(fake.calls[0]).toMatchObject({ table: 'glossary_terms', op: 'delete' });
  });

  it('returns queued results in order, one per statement', async () => {
    const fake = createFakeSupabase([{ data: [1] }, { data: [2] }]);
    const first = await fake.client.from('a').select('*');
    const second = await fake.client.from('b').select('*');
    expect(first.data).toEqual([1]);
    expect(second.data).toEqual([2]);
  });

  it('surfaces a queued error instead of data', async () => {
    const fake = createFakeSupabase([{ error: { message: 'permission denied' } }]);
    const { data, error } = await fake.client.from('projects').select('*');
    expect(data).toBeNull();
    expect(error).toEqual({ message: 'permission denied' });
  });

  it('defaults to an empty successful result when nothing is queued', async () => {
    const fake = createFakeSupabase();
    const { data, error } = await fake.client.from('projects').select('*');
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it('records order and limit modifiers', async () => {
    const fake = createFakeSupabase([{ data: [] }]);
    await fake.client.from('projects').select('*').order('created_at', { ascending: false }).limit(10);
    expect(fake.calls[0].filters).toEqual([
      { kind: 'order', column: 'created_at', value: { ascending: false } },
      { kind: 'limit', column: '', value: 10 }
    ]);
  });
});
