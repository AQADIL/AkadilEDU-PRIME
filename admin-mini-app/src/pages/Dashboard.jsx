import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Users, BrainCircuit, BookOpen, Calendar } from 'lucide-react';
import { useTheme } from '../contexts/theme';
import { db, ref, get } from '../lib/firebase';
import { countQuestionTopics } from '../services/topics';

function Dashboard() {
  const { currentTheme } = useTheme();
  const [stats, setStats] = useState({ totalQuestions: 0, totalTopics: 0, totalUsers: 0, totalCampaigns: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const snapshots = await Promise.all(
          ['questions', 'topics', 'users', 'campaigns'].map(path => get(ref(db, path)))
        );
        const [questionsSnapshot, topicsSnapshot, usersSnapshot, campaignsSnapshot] = snapshots;
        const totalQuestions = questionsSnapshot.exists() ? questionsSnapshot.size : 0;
        const totalTopics = countQuestionTopics(
          topicsSnapshot.exists() ? Object.values(topicsSnapshot.val()) : []
        );
        const totalUsers = usersSnapshot.exists() ? usersSnapshot.size : 0;
        const totalCampaigns = campaignsSnapshot.exists() ? campaignsSnapshot.size : 0;
        setStats({ totalQuestions, totalTopics, totalUsers, totalCampaigns });
        setError('');
      } catch (loadError) {
        setError(loadError.message || 'Unable to load dashboard statistics.');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  const statsData = [
    { label: 'Questions', value: stats.totalQuestions, icon: BrainCircuit, color: 'bg-blue-500/20' },
    { label: 'Question Topics', value: stats.totalTopics, icon: BookOpen, color: 'bg-emerald-500/20' },
    { label: 'Users', value: stats.totalUsers, icon: Users, color: 'bg-purple-500/20' },
    { label: 'Campaigns', value: stats.totalCampaigns, icon: Calendar, color: 'bg-orange-500/20' },
  ];

  const menuItems = [
    { icon: BarChart3, label: 'Overview', path: '/' },
    { icon: Users, label: 'Users', path: '/users' },
    { icon: BrainCircuit, label: 'Questions', path: '/questions' },
    { icon: BookOpen, label: 'Topics', path: '/topics' },
    { icon: Calendar, label: 'Scheduler', path: '/campaigns' },
  ];

  return (
    <div className="min-h-screen animate-fade-in">
      <div className={`${currentTheme.card} backdrop-blur-xl border-b border-white/10`}>
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className={`text-2xl font-bold ${currentTheme.text}`}>
            Admin Dashboard
          </h1>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {error && <div role="alert" className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-red-200">Statistics could not be loaded: {error}</div>}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-400"></div>
          </div>
        ) : !error ? (
          <>
            <div className="grid grid-cols-2 gap-4 mb-8">
              {statsData.map((stat, index) => (
                <div
                  key={stat.label}
                  className={`${currentTheme.card} backdrop-blur-xl rounded-2xl p-4 border border-white/10 shadow-xl animate-fade-in`}
                  style={{ animationDelay: `${index * 50}ms` }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className={`text-sm ${currentTheme.textSecondary} mb-1`}>
                        {stat.label}
                      </p>
                      <p className={`text-2xl font-bold ${currentTheme.text}`}>
                        {stat.value}
                      </p>
                    </div>
                    <div className={`${stat.color} p-3 rounded-xl`}>
                      <stat.icon className={`w-6 h-6 ${currentTheme.text}`} />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className={`${currentTheme.card} backdrop-blur-xl rounded-2xl p-6 border border-white/10 shadow-xl animate-scale-in`}>
              <h2 className={`text-lg font-semibold ${currentTheme.text} mb-4`}>
                Quick Actions
              </h2>
              <div className="grid grid-cols-1 gap-2">
                {menuItems.map((item, index) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/10 transition-colors animate-slide-in"
                    style={{ animationDelay: `${index * 30}ms` }}
                  >
                    <item.icon className={`w-5 h-5 ${currentTheme.textSecondary}`} />
                    <span className={currentTheme.text}>{item.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default Dashboard;
