// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from '../App';

// jsdom starts with empty storage, so there is no session however the local
// .env is filled in — which is the state that matters: a visitor with no
// session must never reach the console, and the only way forward is Google.
describe('access guard', () => {
  afterEach(cleanup);

  it('sends a visitor with no session to the login page', async () => {
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

  it('offers Google as the only way in — no password field to attack', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' });
    expect(screen.getByRole('button', { name: /Google/ })).toBeTruthy();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[type="email"]')).toBeNull();
  });
});
