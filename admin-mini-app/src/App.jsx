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
  const { user, loading, error } = useTelegramAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto"></div>
          <p className="mt-4 text-white/70">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !user) {
    return <Login error={error} />;
  }

  return (
    <Router>
      <div className={`min-h-screen ${currentTheme.background}`}>
        <Suspense fallback={<div className={`p-6 ${currentTheme.text}`}>Loading page…</div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
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
