import type { ErrorCode } from './protocol';

export interface CloseDescription {
  message: string;
  /** The session id is dead. Clear it; never reconnect with it. */
  sessionGone: boolean;
  /** Safe to reconnect, possibly after obtaining a fresh token. */
  retryable: boolean;
}

const CLOSE_CODES: Record<number, CloseDescription> = {
  1000: { message: 'ปิดการเชื่อมต่อแล้ว (closed normally)', sessionGone: false, retryable: false },
  4401: {
    message: 'โทเคนหมดอายุหรือไม่ถูกต้อง — กำลังขอโทเคนใหม่ (token expired or invalid)',
    sessionGone: false,
    retryable: true,
  },
  4403: {
    message: 'สิทธิ์ไม่เพียงพอสำหรับการเชื่อมต่อนี้ (forbidden for this role or session)',
    sessionGone: false,
    retryable: false,
  },
  4404: {
    // The registry is in memory; a backend restart makes every existing id
    // invalid. Reconnecting with the same id can only fail again, so the UI
    // must offer a NEW session instead of retrying.
    message: 'เซสชันนี้ไม่มีอยู่แล้ว — เซิร์ฟเวอร์อาจรีสตาร์ต ต้องสร้างเซสชันใหม่ (session no longer exists)',
    sessionGone: true,
    retryable: false,
  },
  4408: {
    message: 'มีอุปกรณ์อื่นกำลังส่งเสียงเข้าเซสชันนี้อยู่แล้ว (another device is already sending audio)',
    sessionGone: false,
    retryable: false,
  },
  4409: {
    message: 'เวอร์ชันโปรโตคอลไม่ตรงกับเซิร์ฟเวอร์ (unsupported protocol version)',
    sessionGone: false,
    retryable: false,
  },
  4429: {
    message: 'ส่งคำสั่งถี่เกินไป ระบบตัดการเชื่อมต่อชั่วคราว (rate limited)',
    sessionGone: false,
    retryable: true,
  },
};

export function describeCloseCode(code: number): CloseDescription {
  return (
    CLOSE_CODES[code] ?? {
      message: `การเชื่อมต่อถูกปิด (closed, code ${code})`,
      sessionGone: false,
      retryable: true,
    }
  );
}

const ERROR_CODES: Partial<Record<ErrorCode, string>> = {
  unauthenticated: 'โทเคนไม่ถูกต้องหรือหมดอายุ (unauthenticated)',
  forbidden: 'คำสั่งนี้ต้องใช้สิทธิ์ operator (operator role required)',
  bad_request: 'รูปแบบคำสั่งไม่ถูกต้อง (bad request)',
  not_found: 'ไม่พบสิ่งที่อ้างถึง (not found)',
  conflict: 'สถานะขัดแย้งกัน (conflict)',
  rate_limited: 'ส่งคำสั่งถี่เกินไป (rate limited)',
};

export function describeErrorCode(code: ErrorCode, fallback: string): string {
  return ERROR_CODES[code] ?? fallback;
}
