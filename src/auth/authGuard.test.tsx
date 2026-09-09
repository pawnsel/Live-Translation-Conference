// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from '../App';

// No VITE_SUPABASE_* is set under test, so the client is null: the app must
// still boot, keep the console locked, and say what is missing rather than
// throwing somewhere inside a query.
describe('access guard', () => {
  afterEach(cleanup);

  it('sends an unauthenticated visitor to the login page', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeTruthy();
  });

  it('never renders the console without an approved session', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' });
    // Controls that exist only inside the operator console.
    expect(screen.queryByTitle('เปิดเมนูตั้งค่า')).toBeNull();
    expect(screen.queryByTitle('โปรไฟล์ผู้ใช้')).toBeNull();
  });

  it('explains that Supabase is not configured', async () => {
    render(<App />);
    expect(await screen.findByText(/VITE_SUPABASE_URL/)).toBeTruthy();
  });
});
