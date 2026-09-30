import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Save, X, Folder, FolderOpen, FileText, Edit, Trash2, ArrowLeft } from 'lucide-react';
import { useTheme } from '../contexts/theme';
import { getTopics, createTopic, updateTopic, deleteTopic } from '../services/topics';

export default function Topics() {
  const { currentTheme } = useTheme();
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingTopic, setEditingTopic] = useState(null);
  const [expandedTopics, setExpandedTopics] = useState(new Set());
  const [parentTopicId, setParentTopicId] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    parentId: '',
    customId: '',
    visible: true
  });

  useEffect(() => {
    let active = true;
    async function loadTopics() {
      try {
        const data = await getTopics();
        if (active) setTopics(data);
      } catch {
        if (active) setLoadError('Could not load topics. Check your access and connection.');
      } finally {
        if (active) setLoading(false);
      }
    }
    loadTopics();
    return () => { active = false; };
  }, []);

  const toggleExpand = (topicId) => {
    const newExpanded = new Set(expandedTopics);
    if (newExpanded.has(topicId)) {
      newExpanded.delete(topicId);
    } else {
      newExpanded.add(topicId);
    }
    setExpandedTopics(newExpanded);
  };

  const buildTopicTree = (parentId = '') => {
    return topics
      .filter(topic => topic.parentId === parentId)
      .sort((a, b) => {
        const aHidden = a.visible === false || a.isActive === false;
        const bHidden = b.visible === false || b.isActive === false;
        if (aHidden !== bHidden) {
          return aHidden ? 1 : -1;
        }
        return (a.name || a.id).localeCompare(b.name || b.id);
      })
      .map(topic => ({
        ...topic,
        children: buildTopicTree(topic.id)
      }));
  };

  const topicTree = buildTopicTree('');

  const handleCreate = async () => {
    try {
      await createTopic({ ...formData, parentId: parentTopicId });
      setShowCreateForm(false);
      setParentTopicId('');
      resetForm();
      try {
        setTopics(await getTopics());
      } catch {
        setLoadError('Topic saved, but the list could not refresh. Reload the page.');
      }
    } catch (error) {
      alert(error.message || 'Failed to create topic.');
    }
  };

  const handleUpdate = async () => {
    try {
      await updateTopic(editingTopic.id, { ...formData, parentId: parentTopicId });
      setEditingTopic(null);
      resetForm();
      setParentTopicId('');
      try {
        setTopics(await getTopics());
      } catch {
        setLoadError('Topic saved, but the list could not refresh. Reload the page.');
      }
    } catch (error) {
      alert(error.message || 'Failed to update topic.');
    }
  };

  const handleDelete = async (topicId) => {
    if (confirm('Delete this topic? Move or delete its subtopics, questions, campaigns, and materials first.')) {
      try {
        await deleteTopic(topicId);
        try {
          setTopics(await getTopics());
        } catch {
          setLoadError('Topic deleted, but the list could not refresh. Reload the page.');
        }
      } catch (error) {
        alert(error.message || 'Failed to delete topic.');
      }
    }
  };

  const startCreateInTopic = (topicId) => {
    setParentTopicId(topicId);
    setFormData({
      name: '',
      parentId: topicId,
      customId: '',
      visible: true
    });
    setShowCreateForm(true);
  };

  const startEdit = (topic) => {
    setEditingTopic(topic);
    setParentTopicId(topic.parentId || '');
    setFormData({
      name: topic.name || '',
      parentId: topic.parentId || '',
      customId: topic.id || '',
      visible: topic.visible !== false && topic.isActive !== false
    });
  };

  const resetForm = () => {
    setFormData({
      name: '',
      parentId: '',
      customId: '',
      visible: true
    });
  };

  const isUnavailableParent = (candidateId) => {
    if (!editingTopic) return false;
    let currentId = candidateId;
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      if (currentId === editingTopic.id) return true;
      visited.add(currentId);
      currentId = topics.find(topic => topic.id === currentId)?.parentId || '';
    }
    return false;
  };

  const renderTopicNode = (topic, level = 0) => {
    const hasChildren = topic.children && topic.children.length > 0;
    const isExpanded = expandedTopics.has(topic.id);
    const isHidden = topic.visible === false || topic.isActive === false;

    return (
      <div key={topic.id} className="mb-1">
        <div
          className={`rounded-lg p-3 hover:bg-white/20 transition-colors cursor-pointer ${
            isHidden
              ? 'border-2 border-green-500/50'
              : 'bg-white/10 border border-white/20'
          }`}
          style={{ marginLeft: level * 24 }}
        >
          <div className="flex items-center justify-between">
            <div
              className="flex items-center gap-2 flex-1"
              onClick={() => hasChildren && toggleExpand(topic.id)}
            >
              {hasChildren ? (
                isExpanded ? (
                  <FolderOpen className={`w-5 h-5 ${isHidden ? 'text-green-400' : 'text-yellow-500'}`} />
                ) : (
                  <Folder className={`w-5 h-5 ${isHidden ? 'text-green-400' : 'text-yellow-500'}`} />
                )
              ) : (
                <FileText className={`w-5 h-5 ${isHidden ? 'text-green-400' : 'text-blue-400'}`} />
              )}
              <span className={`${currentTheme.text} font-medium`}>{topic.name}</span>
              {isHidden && (
                <span className="text-green-400 text-xs ml-2 font-medium">Hidden</span>
              )}
            </div>
            <div className="flex gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startCreateInTopic(topic.id);
                }}
                className={`p-2 ${currentTheme.textSecondary} hover:bg-white/20 rounded-lg`}
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit(topic);
                }}
                className={`p-2 ${currentTheme.textSecondary} hover:bg-white/20 rounded-lg`}
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(topic.id);
                }}
                className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
        {isExpanded && hasChildren && (
          <div className="mt-1">
            {topic.children.map(child => renderTopicNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen animate-fade-in">
      <div className={`${currentTheme.card} backdrop-blur-xl border-b border-white/10`}>
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <Link
              to="/"
              className={`flex items-center gap-2 px-4 py-2 bg-white/10 backdrop-blur-xl border border-white/20 rounded-xl ${currentTheme.text} hover:bg-white/20 transition-all shadow-lg hover:shadow-xl`}
            >
              <ArrowLeft className="w-5 h-5" />
              <span className="font-medium">Back</span>
            </Link>
            <h1 className={`text-xl font-bold ${currentTheme.text}`}>
              Topics
            </h1>
            <button
              onClick={() => {
                setParentTopicId('');
                resetForm();
                setShowCreateForm(true);
              }}
              disabled={loading || Boolean(loadError)}
              className={`flex items-center gap-2 bg-white/10 backdrop-blur-xl border border-white/20 ${currentTheme.text} px-4 py-2.5 rounded-2xl font-medium hover:bg-white/20 transition-all shadow-lg hover:shadow-xl animate-scale-in disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Add Topic</span>
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {(showCreateForm || editingTopic) && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className={`${currentTheme.card} backdrop-blur-xl rounded-3xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto border border-white/10 shadow-2xl animate-scale-in`}>
              <div className="flex items-center justify-between mb-4">
                <h2 className={`text-lg font-semibold ${currentTheme.text}`}>
                  {editingTopic ? 'Edit' : 'Create'}
                </h2>
                <button
                  onClick={() => {
                    setShowCreateForm(false);
                    setEditingTopic(null);
                    setParentTopicId('');
                    resetForm();
                  }}
                  className={`${currentTheme.textSecondary} hover:${currentTheme.text} transition-colors`}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  />
                </div>

                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Custom ID</label>
                  <input
                    type="text"
                    value={formData.customId}
                    onChange={(e) => setFormData({ ...formData, customId: e.target.value })}
                    disabled={Boolean(editingTopic)}
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  />
                  {editingTopic && (
                    <p className={`mt-2 text-xs ${currentTheme.textSecondary}`}>Topic IDs stay fixed so questions and campaigns keep their links.</p>
                  )}
                </div>

                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Parent</label>
                  <select
                    value={parentTopicId}
                    onChange={(e) => setParentTopicId(e.target.value)}
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  >
                    <option value="" className="bg-slate-900">Root</option>
                    {topics.filter(topic => !isUnavailableParent(topic.id)).map((topic) => (
                      <option key={topic.id} value={topic.id} className="bg-slate-900">
                        {topic.name || topic.id}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center justify-between p-4 bg-white/10 rounded-2xl">
                  <p className={`${currentTheme.text} font-medium`}>Visible in Bot</p>
                  <button
                    onClick={() => setFormData({ ...formData, visible: !formData.visible })}
                    className={`relative w-14 h-8 rounded-full transition-colors duration-300 ${
                      formData.visible ? 'bg-blue-500' : 'bg-white/20'
                    }`}
                  >
                    <div
                      className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow-lg transition-transform duration-300 ${
                        formData.visible ? 'translate-x-7' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <button
                  onClick={editingTopic ? handleUpdate : handleCreate}
                  className="w-full flex items-center justify-center gap-2 bg-white/10 backdrop-blur-xl border border-white/20 text-white px-6 py-4 rounded-2xl font-medium hover:bg-white/20 transition-all shadow-lg hover:shadow-xl"
                >
                  <Save className="w-5 h-5" />
                  {editingTopic ? 'Update' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        )}

        {loadError ? (
          <div className="flex flex-col items-center gap-4 py-12 text-red-300" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={() => window.location.reload()} className="px-5 py-3 rounded-xl bg-blue-600 text-white">
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-400"></div>
          </div>
        ) : topicTree.length === 0 ? (
          <div className={`text-center py-12 ${currentTheme.textSecondary}`}>
            No topics
          </div>
        ) : (
          <div className={`${currentTheme.card} backdrop-blur-xl rounded-3xl p-4 border border-white/10 shadow-xl`}>
            {topicTree.map(topic => renderTopicNode(topic))}
          </div>
        )}
      </div>
    </div>
  );
}
