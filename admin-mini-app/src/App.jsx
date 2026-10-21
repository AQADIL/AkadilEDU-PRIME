import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useTelegramAuth } from './hooks/useTelegramAuth';
import { ThemeProvider } from './contexts/ThemeContext';
import { useTheme } from './contexts/theme';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';

const Questions = lazy(() => import('./pages/Questions'));
const Topics = lazy(() => import('./pages/Topics'));
const Campaigns = lazy(() => import('./pages/Campaigns'));
const Users = lazy(() => import('./pages/Users'));

function AppContent() {
  const { currentTheme } = useTheme();
  const {
    user,
    loading,
    error,
    verificationError,
    browserRequest,
    startBrowserLogin,
    verifyBrowserOtp,
    cancelBrowserLogin,
    logout,
    stayLoggedIn,
    updateStayLoggedIn,
  } = useTelegramAuth();

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#08090b] text-[#f4f3ef]">
        <span className="text-sm tracking-[0.18em] text-white/50">AkadilEDU</span>
      </div>
    );
  }

  if (error || !user) {
    return (
      <Login
        error={error}
        verificationError={verificationError}
        browserRequest={browserRequest}
        onStartBrowserLogin={startBrowserLogin}
        onVerifyBrowserOtp={verifyBrowserOtp}
        onCancelBrowserLogin={cancelBrowserLogin}
        stayLoggedIn={stayLoggedIn}
        onStayLoggedInChange={updateStayLoggedIn}
      />
    );
  }

  return (
    <Router>
      <div className={`min-h-screen ${currentTheme.background}`}>
        <Suspense fallback={<div className={`p-6 ${currentTheme.text}`}>Loading page…</div>}>
          <Routes>
            <Route path="/" element={<Dashboard onSignOut={logout} />} />
            <Route path="/questions" element={<Questions />} />
            <Route path="/topics" element={<Topics />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/users" element={<Users />} />
          </Routes>
        </Suspense>
      </div>
    </Router>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}

export default App;
