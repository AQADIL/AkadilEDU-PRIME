import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Search, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTheme } from '../contexts/theme';
import { getUserResults, getUsers, setUserBlocked } from '../services/users';

export default function Users() {
  const { currentTheme } = useTheme();
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getUsers().then(data => {
      if (active) setUsers(data);
    }).catch(cause => {
      if (active) setError(cause.message || 'Unable to load users.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? users.filter(user =>
      [user.id, user.username, user.firstName, user.lastName].some(value => String(value || '').toLowerCase().includes(term))) : users;
  }, [query, users]);

  async function selectUser(user) {
    setSelected(user);
    setResults(null);
    setError('');
    try {
      setResults(await getUserResults(user.id));
    } catch (cause) {
      setError(cause.message || 'Unable to load results.');
    }
  }

  async function toggleBlocked(user) {
    setBusy(true);
    setError('');
    try {
      const blocked = user.isBlocked !== true;
      await setUserBlocked(user.id, blocked);
      setUsers(current => current.map(item => item.id === user.id ? { ...item, isBlocked: blocked } : item));
      setSelected(current => current?.id === user.id ? { ...current, isBlocked: blocked } : current);
    } catch (cause) {
      setError(cause.message || 'Unable to update user.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <Link to="/" className={`mb-6 inline-flex items-center gap-2 ${currentTheme.text}`}><ArrowLeft size={18} /> Dashboard</Link>
      <h1 className={`mb-2 text-2xl font-semibold ${currentTheme.text}`}>Students</h1>
      <p className={`mb-6 ${currentTheme.textSecondary}`}>Registered bot users and their recorded answers.</p>
      {error && <p role="alert" className="mb-4 rounded-xl bg-red-500/15 p-3 text-red-200">{error}</p>}
      <label className={`mb-5 flex items-center gap-2 rounded-xl border border-white/15 p-3 ${currentTheme.card}`}>
        <Search size={18} className={currentTheme.textSecondary} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search students" className={`w-full bg-transparent outline-none ${currentTheme.text}`} />
      </label>
      {loading ? <p className={currentTheme.textSecondary}>Loading students…</p> : (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="space-y-2">
            {filtered.length === 0 && <p className={currentTheme.textSecondary}>No students found.</p>}
            {filtered.map(user => (
              <button key={user.id} onClick={() => selectUser(user)} className={`w-full rounded-xl border border-white/10 p-4 text-left ${currentTheme.card}`}>
                <span className={`block font-medium ${currentTheme.text}`}>{[user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.id}</span>
                <span className={`text-sm ${currentTheme.textSecondary}`}>{user.username ? `@${user.username} · ` : ''}{user.id}{user.isBlocked ? ' · Blocked' : ''}</span>
              </button>
            ))}
          </section>
          {selected && <section className={`h-fit rounded-xl border border-white/10 p-5 ${currentTheme.card}`}>
            <h2 className={`mb-3 text-lg font-medium ${currentTheme.text}`}>{[selected.firstName, selected.lastName].filter(Boolean).join(' ') || selected.id}</h2>
            <p className={currentTheme.textSecondary}>Telegram ID: {selected.id}</p>
            <p className={currentTheme.textSecondary}>Language: {selected.language || 'Unknown'}</p>
            {results ? <div className={`my-4 space-y-1 ${currentTheme.text}`}>
              <p>Answers: {results.answered}</p>
              <p>Correct: {results.correct}</p>
              <p>Channel quizzes joined: {results.channelQuizzes}</p>
            </div> : <p className={`my-4 ${currentTheme.textSecondary}`}>Loading recorded results…</p>}
            <button disabled={busy} onClick={() => toggleBlocked(selected)} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-2 text-white disabled:opacity-50">
              {selected.isBlocked ? <ShieldCheck size={18} /> : <ShieldOff size={18} />}{selected.isBlocked ? 'Restore bot access' : 'Block bot access'}
            </button>
          </section>}
        </div>
      )}
    </main>
  );
}
