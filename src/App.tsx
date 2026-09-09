/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import Admin from './pages/Admin';
import Login from './pages/Login';
import Register from './pages/Register';
import AuthCallback from './pages/AuthCallback';
import { AuthProvider, useAuth } from './auth/AuthProvider';

/** The console is for approved accounts only. A session by itself is not
 *  enough — Google hands those out to anyone — so this waits for the approval
 *  status to load (`ready`) before deciding, otherwise a sign-in that has just
 *  succeeded would be bounced by its own guard. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { session, status, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-3 bg-slate-50 text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin text-[#DE5C8E]" />
        <p className="text-sm">กำลังตรวจสอบสิทธิ์การเข้าใช้งาน...</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (status !== 'approved') {
    // Signed in but not (yet) allowed: the login page owns the explanation and
    // ends the session.
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname, blocked: status, email: session.user.email ?? '' }}
      />
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Admin />
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAuth>
                <Admin />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
