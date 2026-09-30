import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Check, Edit3, Pause, Play, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { useTheme } from '../contexts/theme';
import {
  createCampaign,
  deleteCampaign,
  setCampaignEnabled,
  subscribeToCampaigns,
  subscribeToEligibleQuestionCount,
  subscribeToPublications,
  updateCampaign,
  validateCampaign,
  verifyChannel
} from '../services/campaigns';

const emptyForm = {
  name: '',
  channelId: '',
  timezone: '',
  localTime: '',
  language: '',
  questionCount: '',
  intervalMinutes: '',
  answerWindowMinutes: '',
  enabled: false
};

const fields = [
  { key: 'name', label: 'Campaign name', type: 'text', hint: 'A clear name for your team' },
  { key: 'channelId', label: 'Channel', type: 'text', hint: '@username or negative chat ID' },
  { key: 'timezone', label: 'IANA time zone', type: 'text', hint: 'For example, Asia/Almaty' },
  { key: 'localTime', label: 'Daily start time', type: 'time', hint: '24-hour time in the selected zone' },
  { key: 'language', label: 'Channel quiz language', type: 'select', hint: 'Used for questions, alerts, and completion messages' },
  { key: 'questionCount', label: 'Questions per quiz', type: 'number', min: 1, max: 50 },
  { key: 'intervalMinutes', label: 'Minutes between questions', type: 'number', min: 1, max: 1440 },
  { key: 'answerWindowMinutes', label: 'Answer window after final question (minutes)', type: 'number', min: 1, max: 1440 }
];

function formatDate(timestamp) {
  if (timestamp == null || !Number.isFinite(Number(timestamp))) return 'Not available';
  return new Date(Number(timestamp)).toLocaleString();
}

function formatRunStatus(publication) {
  if (!publication) return 'No run yet';
  if (publication.status === 'active') {
    const current = Number.isInteger(publication.currentIndex) ? publication.currentIndex + 1 : null;
    return current && publication.questionCount
      ? `Live · question ${current} of ${publication.questionCount}`
      : 'Live';
  }
  if (publication.status === 'completed') return 'Completed';
  if (publication.status === 'failed') return 'Failed';
  return publication.status || 'Status unavailable';
}

export default function Campaigns() {
  const { currentTheme } = useTheme();
  const [campaigns, setCampaigns] = useState([]);
  const [publications, setPublications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [publicationError, setPublicationError] = useState('');
  const [questionCountError, setQuestionCountError] = useState('');
  const [eligibleQuestionCount, setEligibleQuestionCount] = useState(null);
  const [actionError, setActionError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [deleteId, setDeleteId] = useState(null);
  const [verifiedChannel, setVerifiedChannel] = useState(null);

  useEffect(() => {
    const unsubscribeCampaigns = subscribeToCampaigns(
      values => {
        setCampaigns(values);
        setListError('');
        setLoading(false);
      },
      error => {
        setListError(error.message || 'Unable to load campaigns.');
        setLoading(false);
      }
    );
    const unsubscribePublications = subscribeToPublications(
      values => {
        setPublications(values);
        setPublicationError('');
      },
      error => setPublicationError(error.message || 'Unable to load run status.')
    );
    const unsubscribeQuestions = subscribeToEligibleQuestionCount(
      count => {
        setEligibleQuestionCount(count);
        setQuestionCountError('');
      },
      error => {
        setEligibleQuestionCount(null);
        setQuestionCountError(error.message || 'Unable to check the question bank.');
      }
    );
    return () => {
      unsubscribeCampaigns();
      unsubscribePublications();
      unsubscribeQuestions();
    };
  }, []);

  const latestByCampaign = useMemo(() => {
    const result = new Map();
    for (const publication of publications) {
      if (!publication.campaignId) continue;
      const previous = result.get(publication.campaignId);
      const currentTime = Number(publication.createdAt || publication.scheduledAt || 0);
      const previousTime = Number(previous?.createdAt || previous?.scheduledAt || 0);
      if (!previous || currentTime > previousTime) result.set(publication.campaignId, publication);
    }
    return result;
  }, [publications]);

  const activeCount = campaigns.filter(campaign => campaign.enabled === true).length;
  const liveCount = publications.filter(publication => publication.status === 'active').length;
  const sortedCampaigns = [...campaigns].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  function openNew() {
    setEditingId('new');
    setForm({ ...emptyForm });
    setFieldErrors({});
    setActionError('');
    setDeleteId(null);
    setVerifiedChannel(null);
  }

  function openEdit(campaign) {
    setEditingId(campaign.id);
    setForm({
      name: campaign.name ?? '',
      channelId: campaign.channelId ?? '',
      timezone: campaign.timezone ?? '',
      localTime: campaign.localTime ?? '',
      language: campaign.language ?? '',
      questionCount: campaign.questionCount ?? '',
      intervalMinutes: campaign.intervalMinutes ?? '',
      answerWindowMinutes: campaign.answerWindowMinutes ?? '',
      enabled: campaign.enabled === true
    });
    setFieldErrors({});
    setActionError('');
    setDeleteId(null);
    setVerifiedChannel(null);
  }

  function updateField(key, value) {
    setForm(previous => ({ ...previous, [key]: value }));
    setFieldErrors(previous => ({ ...previous, [key]: undefined }));
    if (key === 'channelId') setVerifiedChannel(null);
  }

  async function checkChannel() {
    setBusyId('verify');
    setActionError('');
    setVerifiedChannel(null);
    try {
      setVerifiedChannel(await verifyChannel(form.channelId));
    } catch (error) {
      setActionError(error.message || 'Could not verify the channel.');
    } finally {
      setBusyId(null);
    }
  }

  async function saveCampaign(event) {
    event.preventDefault();
    const result = validateCampaign(form, eligibleQuestionCount);
    setFieldErrors(result.errors);
    if (eligibleQuestionCount === null) {
      setActionError('Wait for the question bank to load before saving.');
      return;
    }
    if (!result.valid) return;
    setBusyId(editingId);
    setActionError('');
    try {
      if (editingId === 'new') await createCampaign(form);
      else await updateCampaign(editingId, form);
      setEditingId(null);
      setForm({ ...emptyForm });
    } catch (error) {
      setActionError(error.message || 'Could not save the campaign.');
      if (error.fields) setFieldErrors(error.fields);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleCampaign(campaign) {
    if (!campaign.enabled && eligibleQuestionCount === null) {
      setActionError('Wait for the question bank to load before enabling a campaign.');
      return;
    }
    setBusyId(campaign.id);
    setActionError('');
    try {
      await setCampaignEnabled(campaign, !campaign.enabled);
    } catch (error) {
      setActionError(error.fields
        ? `Complete ${campaign.name || 'this campaign'} before enabling it.`
        : error.message || 'Could not change campaign status.');
    } finally {
      setBusyId(null);
    }
  }

  async function removeCampaign(campaign) {
    setBusyId(campaign.id);
    setActionError('');
    try {
      await deleteCampaign(campaign.id);
      setDeleteId(null);
      if (editingId === campaign.id) setEditingId(null);
    } catch (error) {
      setActionError(error.message || 'Could not delete the campaign.');
    } finally {
      setBusyId(null);
    }
  }

  const controlClass = 'w-full rounded-xl border border-white/20 bg-black/20 px-3 py-2.5 text-white outline-none focus:border-blue-400 disabled:opacity-50';

  return (
    <div className="min-h-screen animate-fade-in pb-12">
      <header className={`${currentTheme.card} border-b border-white/10`}>
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4">
          <Link to="/" className={`flex items-center gap-2 rounded-xl border border-white/20 px-3 py-2 ${currentTheme.text}`}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <h1 className={`text-xl font-bold ${currentTheme.text}`}>Daily channel quizzes</h1>
          <button type="button" onClick={openNew} className="flex items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500">
            <Plus className="h-4 w-4" /> New
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-6">
        <div className={`rounded-2xl border border-white/10 p-5 ${currentTheme.card}`}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div><span className={currentTheme.textSecondary}>Configured</span><strong className={`ml-2 ${currentTheme.text}`}>{campaigns.length}</strong></div>
            <div><span className={currentTheme.textSecondary}>Enabled</span><strong className={`ml-2 ${currentTheme.text}`}>{activeCount}</strong></div>
            <div><span className={currentTheme.textSecondary}>Live runs</span><strong className={`ml-2 ${currentTheme.text}`}>{liveCount}</strong></div>
            <div><span className={currentTheme.textSecondary}>Max questions per quiz</span><strong className={`ml-2 ${currentTheme.text}`}>{eligibleQuestionCount ?? 'Checking…'}</strong></div>
          </div>
          <p className={`mt-3 text-sm ${currentTheme.textSecondary}`}>Each enabled campaign starts daily in its selected time zone. One real problem per topic remains available for similar practice. Add the bot as a channel administrator before enabling a campaign.</p>
        </div>

        {listError && <div role="alert" className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-red-200">Campaigns could not be loaded: {listError}</div>}
        {publicationError && <div role="alert" className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-amber-100">Run status is unavailable: {publicationError}</div>}
        {questionCountError && <div role="alert" className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-amber-100">Question bank could not be checked: {questionCountError}</div>}
        {actionError && <div role="alert" className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-red-200">{actionError}</div>}

        {editingId && (
          <form onSubmit={saveCampaign} className={`space-y-5 rounded-2xl border border-blue-400/30 p-5 ${currentTheme.card}`}>
            <div className="flex items-center justify-between">
              <h2 className={`text-lg font-semibold ${currentTheme.text}`}>{editingId === 'new' ? 'New campaign' : 'Edit campaign'}</h2>
              <button type="button" onClick={() => setEditingId(null)} aria-label="Close editor" className={currentTheme.textSecondary}><X className="h-5 w-5" /></button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {fields.map(field => (
                <label key={field.key} className="block">
                  <span className={`mb-1 block text-sm font-medium ${currentTheme.text}`}>{field.label}</span>
                  {field.type === 'select' ? (
                    <select
                      value={form[field.key]}
                      onChange={event => updateField(field.key, event.target.value)}
                      className={controlClass}
                      aria-invalid={Boolean(fieldErrors[field.key])}
                      aria-describedby={fieldErrors[field.key] ? `${field.key}-error` : undefined}
                      required
                    >
                      <option value="">Select a language</option>
                      <option value="kk">Қазақша</option>
                      <option value="ru">Русский</option>
                      <option value="en">English</option>
                    </select>
                  ) : (
                    <input
                      type={field.type}
                      min={field.min}
                      max={field.max}
                      value={form[field.key]}
                      onChange={event => updateField(field.key, event.target.value)}
                      className={controlClass}
                      aria-invalid={Boolean(fieldErrors[field.key])}
                      aria-describedby={fieldErrors[field.key] ? `${field.key}-error` : undefined}
                      required
                    />
                  )}
                  {field.hint && <span className={`mt-1 block text-xs ${currentTheme.textSecondary}`}>{field.hint}</span>}
                  {fieldErrors[field.key] && <span id={`${field.key}-error`} className="mt-1 block text-xs text-red-300">{fieldErrors[field.key]}</span>}
                </label>
              ))}
            </div>
            <label className={`flex items-start gap-3 text-sm ${currentTheme.text}`}>
              <input type="checkbox" checked={form.enabled} onChange={event => updateField('enabled', event.target.checked)} className="mt-1" />
              <span>Enable daily publishing after saving</span>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" disabled={busyId !== null || !form.channelId.trim()} onClick={checkChannel} className={`inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-2 ${currentTheme.text} disabled:opacity-50`}>
                <ShieldCheck className="h-4 w-4" /> Verify bot channel access
              </button>
              {verifiedChannel && <span className="text-sm text-emerald-300">Verified: {verifiedChannel.title || verifiedChannel.channelId}</span>}
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="submit" disabled={busyId !== null} className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 font-medium text-white disabled:opacity-50">
                <Save className="h-4 w-4" /> {busyId ? 'Saving…' : 'Save campaign'}
              </button>
              <button type="button" onClick={() => setEditingId(null)} className={`rounded-xl border border-white/20 px-4 py-2.5 ${currentTheme.text}`}>Cancel</button>
            </div>
          </form>
        )}

        {loading ? (
          <div className={`flex items-center justify-center gap-3 py-12 ${currentTheme.textSecondary}`}><RefreshCw className="h-5 w-5 animate-spin" /> Loading campaigns…</div>
        ) : !listError && sortedCampaigns.length === 0 ? (
          <div className={`rounded-2xl border border-white/10 p-8 text-center ${currentTheme.card}`}>
            <CalendarClock className={`mx-auto mb-3 h-9 w-9 ${currentTheme.textSecondary}`} />
            <p className={currentTheme.text}>No daily quizzes configured</p>
            <p className={`mt-1 text-sm ${currentTheme.textSecondary}`}>Create a campaign to set the channel, local publish time, and question pacing.</p>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {sortedCampaigns.map(campaign => {
              const latestRun = latestByCampaign.get(campaign.id);
              const validation = validateCampaign(campaign, eligibleQuestionCount);
              const invalid = !validation.valid;
              return (
                <article key={campaign.id} className={`rounded-2xl border border-white/10 p-5 ${currentTheme.card}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className={`text-lg font-semibold ${currentTheme.text}`}>{campaign.name || 'Incomplete campaign'}</h2>
                      <p className={`mt-1 break-all text-sm ${currentTheme.textSecondary}`}>{campaign.channelId || 'Channel required'}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${campaign.enabled ? 'bg-emerald-500/20 text-emerald-200' : 'bg-white/10 text-white/70'}`}>{campaign.enabled ? 'Enabled' : 'Paused'}</span>
                  </div>
                  {invalid && <p className="mt-3 rounded-lg bg-amber-500/10 p-2 text-sm text-amber-100">{validation.errors.questionCount || 'Configuration incomplete. Edit the campaign before enabling it.'}</p>}
                  <dl className={`mt-4 grid grid-cols-2 gap-3 text-sm ${currentTheme.textSecondary}`}>
                    <div><dt>Daily start</dt><dd className={currentTheme.text}>{campaign.localTime || 'Unset'} · {campaign.timezone || 'Time zone required'}</dd></div>
                    <div><dt>Questions</dt><dd className={currentTheme.text}>{campaign.questionCount ?? 'Unset'}</dd></div>
                    <div><dt>Channel language</dt><dd className={currentTheme.text}>{{ kk: 'Қазақша', ru: 'Русский', en: 'English' }[campaign.language] || 'Unset'}</dd></div>
                    <div><dt>Question interval</dt><dd className={currentTheme.text}>{campaign.intervalMinutes ? `${campaign.intervalMinutes} min` : 'Unset'}</dd></div>
                    <div><dt>Final answer window</dt><dd className={currentTheme.text}>{campaign.answerWindowMinutes ? `${campaign.answerWindowMinutes} min` : 'Unset'}</dd></div>
                  </dl>
                  <div className="mt-4 rounded-xl bg-black/15 p-3">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${latestRun?.status === 'active' ? 'bg-emerald-400' : 'bg-white/40'}`} />
                      <span className={`text-sm font-medium ${currentTheme.text}`}>{formatRunStatus(latestRun)}</span>
                    </div>
                    {latestRun && <p className={`mt-1 text-xs ${currentTheme.textSecondary}`}>Started {formatDate(latestRun.createdAt || latestRun.scheduledAt)}{latestRun.status === 'completed' ? ` · Finished ${formatDate(latestRun.completedAt)}` : ''}</p>}
                    {campaign.lastRunKey && <p className={`mt-1 text-xs ${currentTheme.textSecondary}`}>Last scheduled day: {campaign.lastRunKey}</p>}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" onClick={() => openEdit(campaign)} className={`flex items-center gap-2 rounded-xl border border-white/20 px-3 py-2 text-sm ${currentTheme.text}`}><Edit3 className="h-4 w-4" /> Edit</button>
                    <button type="button" disabled={busyId !== null || (!campaign.enabled && (invalid || eligibleQuestionCount === null))} onClick={() => toggleCampaign(campaign)} className={`flex items-center gap-2 rounded-xl border border-white/20 px-3 py-2 text-sm disabled:opacity-40 ${currentTheme.text}`}>
                      {campaign.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{campaign.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button type="button" onClick={() => setDeleteId(campaign.id)} className="flex items-center gap-2 rounded-xl border border-red-400/30 px-3 py-2 text-sm text-red-200"><Trash2 className="h-4 w-4" /> Delete</button>
                  </div>
                  {deleteId === campaign.id && (
                    <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
                      <p>Delete this schedule? Past quiz runs and learner answers remain recorded.</p>
                      <div className="mt-3 flex gap-2">
                        <button type="button" disabled={busyId !== null} onClick={() => removeCampaign(campaign)} className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 disabled:opacity-50"><Check className="h-4 w-4" /> Delete</button>
                        <button type="button" onClick={() => setDeleteId(null)} className="rounded-lg border border-white/20 px-3 py-1.5">Cancel</button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
