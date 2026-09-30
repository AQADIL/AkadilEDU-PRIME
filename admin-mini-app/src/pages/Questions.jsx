import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Search, Filter, Trash2, Save, Upload, Check, X, Copy, SquarePen, ChevronDown, ChevronRight, ChevronLeft, Folder, FolderOpen, FileText, ArrowLeft, Image as ImageIcon, Loader2, CheckSquare, Square, ListChecks } from 'lucide-react';
import { useTheme } from '../contexts/theme';
import { getQuestions, createQuestion, updateQuestion, deleteQuestion, getTopics, validateQuestion } from '../services/questions';
import { compressImage, uploadImageToStorage, deleteImageFromStorage, processTextWithLatex, detectLatexInText } from '../services/imageUtils';
import { storage, storageRef } from '../lib/firebase';
import LatexPreviewCard from '../components/LatexPreviewCard';

export default function Questions() {
  const { currentTheme } = useTheme();
  const [questions, setQuestions] = useState([]);
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [topicSearch, setTopicSearch] = useState('');
  const [showTopicDropdown, setShowTopicDropdown] = useState(false);
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [parsedQuestions, setParsedQuestions] = useState([]);
  const [showPreview, setShowPreview] = useState(false);
  const [bulkTopicSearch, setBulkTopicSearch] = useState('');
  const [showBulkTopicDropdown, setShowBulkTopicDropdown] = useState(false);
  const [selectedBulkTopic, setSelectedBulkTopic] = useState('');
  const [expandedTopicNodes, setExpandedTopicNodes] = useState(new Set());
  const [selectedTopicFilter, setSelectedTopicFilter] = useState('');
  const [showTopicTree, setShowTopicTree] = useState(true);
  const [imagePreview, setImagePreview] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [showLatexPreview, setShowLatexPreview] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedQuestions, setSelectedQuestions] = useState(new Set());
  const [showBulkActions, setShowBulkActions] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveTopicSearch, setMoveTopicSearch] = useState('');
  const [showMoveTopicDropdown, setShowMoveTopicDropdown] = useState(false);
  const [animatingQuestions, setAnimatingQuestions] = useState(new Set());
  const [animationType, setAnimationType] = useState(null);
  const [mobileTopicPath, setMobileTopicPath] = useState([]);
  const [templateCopied, setTemplateCopied] = useState(false);
  const [formData, setFormData] = useState({
    text: '',
    options: ['', '', '', ''],
    correctOption: null,
    explanation: '',
    hint: '',
    difficulty: 'medium',
    topic: '',
    status: 'published',
    imageUrl: ''
  });

  useEffect(() => {
    let active = true;
    async function loadData() {
      try {
        const [questionsData, topicsData] = await Promise.all([getQuestions(), getTopics()]);
        if (active) {
          setQuestions(questionsData);
          setTopics(topicsData);
        }
      } catch {
        if (active) setLoadError('Could not load questions or topics. Check your access and connection.');
      } finally {
        if (active) setLoading(false);
      }
    }
    loadData();
    return () => { active = false; };
  }, []);

  const filteredQuestions = questions.filter(q =>
    (q.text?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    q.topic?.toLowerCase().includes(searchQuery.toLowerCase())) &&
    (!selectedTopicFilter || q.topic === selectedTopicFilter)
  );

  const countQuestionsByTopic = (topicId) => {
    return questions.filter(q => q.topic === topicId).length;
  };

  const buildTopicTreeWithCounts = (parentId = '') => {
    const filteredTopics = topics
      .filter(topic => topic.parentId === parentId)
      .sort((a, b) => {
        if (a.hidden !== b.hidden) {
          return a.hidden ? 1 : -1;
        }
        return (a.name || a.id).localeCompare(b.name || b.id);
      })
      .map(topic => {
        const directCount = countQuestionsByTopic(topic.id);
        const children = buildTopicTreeWithCounts(topic.id);
        const childrenCount = children.reduce((sum, child) => sum + child.totalCount, 0);
        return {
          ...topic,
          children,
          directCount,
          totalCount: directCount + childrenCount
        };
      });
    return filteredTopics;
  };

  const toggleTopicNode = (topicId) => {
    const newExpanded = new Set(expandedTopicNodes);
    if (newExpanded.has(topicId)) {
      newExpanded.delete(topicId);
    } else {
      newExpanded.add(topicId);
    }
    setExpandedTopicNodes(newExpanded);
  };

  const handleTopicFilter = (topicId) => {
    setSelectedTopicFilter(topicId === selectedTopicFilter ? '' : topicId);
  };

  const handleMobileTopicClick = (topic) => {
    const isLast = topic.isLast !== false;
    if (!isLast) {
      setMobileTopicPath([...mobileTopicPath, topic]);
    } else {
      setSelectedTopicFilter(topic.id);
    }
  };

  const handleMobileTopicBack = () => {
    if (mobileTopicPath.length > 0) {
      const currentTopic = mobileTopicPath[mobileTopicPath.length - 1];
      const isLast = currentTopic.isLast !== false;

      if (isLast) {
        setSelectedTopicFilter('');
        setMobileTopicPath([]);
      } else {
        const newPath = [...mobileTopicPath];
        newPath.pop();
        setMobileTopicPath(newPath);
      }
    }
  };

  const getCurrentMobileTopics = () => {
    let currentTopics;
    if (mobileTopicPath.length === 0) {
      currentTopics = topics.filter(t => !t.parentId);
    } else {
      const currentParent = mobileTopicPath[mobileTopicPath.length - 1];
      currentTopics = topics.filter(t => t.parentId === currentParent.id);
    }

    return currentTopics.sort((a, b) => {
      if (a.hidden !== b.hidden) {
        return a.hidden ? 1 : -1;
      }
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
  };

  const renderTopicTreeNode = (topic, level = 0) => {
    const hasChildren = topic.children && topic.children.length > 0;
    const isExpanded = expandedTopicNodes.has(topic.id);
    const isSelected = selectedTopicFilter === topic.id;
    const isLast = topic.isLast !== false;
    const isCentered = !selectedTopicFilter;

    return (
      <div key={topic.id} className="mb-1">
        <div
          className={`rounded-lg ${isCentered ? 'p-4' : 'p-3'} hover:bg-white/20 transition-colors cursor-pointer overflow-hidden ${
            isSelected
              ? 'bg-blue-500/20 border-2 border-blue-500/50'
              : 'bg-white/10 border border-white/20'
          }`}
          style={{ marginLeft: level * 16 }}
        >
          <div className="flex items-center justify-between gap-3 overflow-hidden">
            <div
              className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden"
              onClick={() => {
                if (!isLast) {
                  toggleTopicNode(topic.id);
                } else {
                  handleTopicFilter(topic.id);
                }
              }}
            >
              {!isLast ? (
                isExpanded ? (
                  <ChevronDown className={`${currentTheme.textSecondary} shrink-0 ${isCentered ? 'w-5 h-5' : 'w-4 h-4'}`} />
                ) : (
                  <ChevronRight className={`${currentTheme.textSecondary} shrink-0 ${isCentered ? 'w-5 h-5' : 'w-4 h-4'}`} />
                )
              ) : (
                <div className={`shrink-0 ${isCentered ? 'w-5 h-5' : 'w-4 h-4'}`} />
              )}
              {!isLast ? (
                isExpanded ? (
                  <FolderOpen className={`text-yellow-500 shrink-0 ${isCentered ? 'w-6 h-6' : 'w-5 h-5'}`} />
                ) : (
                  <Folder className={`text-yellow-500 shrink-0 ${isCentered ? 'w-6 h-6' : 'w-5 h-5'}`} />
                )
              ) : (
                <FileText className={`text-blue-400 shrink-0 ${isCentered ? 'w-6 h-6' : 'w-5 h-5'}`} />
              )}
              <span className={`${currentTheme.text} ${isCentered ? 'text-base' : 'text-sm'} font-medium line-clamp-2 break-words leading-tight`}>{topic.name || topic.id}</span>
              {topic.customId && (
                <span className={`${currentTheme.textSecondary} text-xs ml-2 shrink-0`}>({topic.customId})</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 whitespace-nowrap text-right">
              <span className={`${isCentered ? 'text-base' : 'text-sm'} font-semibold ${currentTheme.textSecondary}`}>
                {topic.totalCount}
              </span>
            </div>
          </div>
        </div>
        {hasChildren && isExpanded && (
          <div className="mt-1">
            {topic.children.map(child => renderTopicTreeNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  const topicTree = buildTopicTreeWithCounts();

  const deleteManagedImage = async (imageUrl) => {
    if (!imageUrl) return;
    let imageReference;
    try {
      imageReference = storageRef(storage, imageUrl);
    } catch {
      return;
    }
    if (imageReference.bucket === storage.app.options.storageBucket
      && imageReference.fullPath.startsWith('questions/')) {
      await deleteImageFromStorage(imageUrl);
    }
  };

  const handleCreate = async () => {
    let generatedImageUrl = '';
    let saved = false;
    try {
      validateQuestion(formData);
      const selectedTopic = topics.find(topic => topic.id === formData.topic);
      if (!selectedTopic || selectedTopic.isLast === false) {
        throw new Error('Select an existing leaf topic.');
      }
      let finalImageUrl = formData.imageUrl;

      if (showLatexPreview && !finalImageUrl) {
        const latexImage = await processTextWithLatex(formData.text);
        if (latexImage) {
          const imagePath = `questions/${crypto.randomUUID()}/latex_${crypto.randomUUID()}.png`;
          finalImageUrl = await uploadImageToStorage(latexImage, imagePath);
          generatedImageUrl = finalImageUrl;
        }
      }

      await createQuestion({ ...formData, imageUrl: finalImageUrl });
      saved = true;
      const newQuestions = await getQuestions();
      setQuestions(newQuestions);
      setShowCreateForm(false);
      resetForm();
    } catch (error) {
      if (saved) {
        setShowCreateForm(false);
        resetForm();
        alert('Question saved, but the list could not refresh. Reload the page.');
      } else {
        if (generatedImageUrl) {
          try {
            await deleteManagedImage(generatedImageUrl);
          } catch {
            alert('Question was not saved, and its generated image could not be removed.');
          }
        }
        alert(error.message || 'Failed to create question.');
      }
    }
  };

  const handleUpdate = async () => {
    let saved = false;
    try {
      validateQuestion(formData);
      await updateQuestion(editingQuestion.id, formData);
      saved = true;
      if (editingQuestion.imageUrl && editingQuestion.imageUrl !== formData.imageUrl) {
        try {
          await deleteManagedImage(editingQuestion.imageUrl);
        } catch {
          alert('Question saved, but the old image could not be removed.');
        }
      }
      const newQuestions = await getQuestions();
      setQuestions(newQuestions);
      setEditingQuestion(null);
      resetForm();
    } catch (error) {
      if (saved) {
        setEditingQuestion(null);
        resetForm();
        alert('Question saved, but the list could not refresh. Reload the page.');
      } else {
        alert(error.message || 'Failed to update question.');
      }
    }
  };

  const handleImageUpload = async (file) => {
    if (!file) return;

    setIsUploading(true);
    try {
      const compressedFile = await compressImage(file);
      const questionId = editingQuestion?.id || crypto.randomUUID();
      const imagePath = `questions/${questionId}/image_${crypto.randomUUID()}.jpg`;
      const imageUrl = await uploadImageToStorage(compressedFile, imagePath);

      setFormData({ ...formData, imageUrl });
      setImagePreview(imageUrl);
      setShowLatexPreview(false);
    } catch (error) {
      alert(error.message || 'Failed to upload image.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleTextChange = (text) => {
    setFormData({ ...formData, text });

    const latexMatches = detectLatexInText(text);
    setShowLatexPreview(latexMatches.length > 0);
  };

  const handleRemoveImage = async () => {
    try {
      if (formData.imageUrl && formData.imageUrl !== editingQuestion?.imageUrl) {
        await deleteManagedImage(formData.imageUrl);
      }
      setFormData({ ...formData, imageUrl: '' });
      setImagePreview(null);
      setShowLatexPreview(false);
    } catch (error) {
      alert(error.message || 'Failed to remove image.');
    }
  };

  const handleDelete = async (questionId) => {
    if (confirm('Are you sure you want to delete this question?')) {
      try {
        const question = questions.find(item => item.id === questionId);
        await deleteQuestion(questionId);
        setQuestions(current => current.filter(item => item.id !== questionId));
        try {
          await deleteManagedImage(question?.imageUrl);
        } catch {
          alert('Question deleted, but its image could not be removed.');
        }
      } catch (error) {
        alert(error.message || 'Failed to delete question.');
      }
    }
  };

  const startEdit = (question) => {
    setEditingQuestion(question);
    setFormData({
      text: question.text || '',
      options: question.options || ['', '', '', ''],
      correctOption: Number.isInteger(question.correctOption) ? question.correctOption : null,
      explanation: question.explanation || '',
      hint: question.hint || '',
      difficulty: question.difficulty || 'medium',
      topic: question.topic || '',
      status: question.status || 'published',
      imageUrl: question.imageUrl || ''
    });
    if (question.topic) {
      setTopicSearch(getTopicPath(question.topic));
    }
    if (question.imageUrl) {
      setImagePreview(question.imageUrl);
    }
  };

  const resetForm = () => {
    setFormData({
      text: '',
      options: ['', '', '', ''],
      correctOption: null,
      explanation: '',
      hint: '',
      difficulty: 'medium',
      topic: '',
      status: 'published',
      imageUrl: ''
    });
    setImagePreview(null);
    setTopicSearch('');
    setShowLatexPreview(false);
    setIsSelectionMode(false);
    setSelectedQuestions(new Set());
    setShowBulkActions(false);
  };

  const discardForm = async () => {
    try {
      if (formData.imageUrl && formData.imageUrl !== editingQuestion?.imageUrl) {
        await deleteManagedImage(formData.imageUrl);
      }
      setShowCreateForm(false);
      setEditingQuestion(null);
      resetForm();
      setIsBulkMode(false);
    } catch (error) {
      alert(error.message || 'Could not remove the unsaved image.');
    }
  };

  const toggleQuestionSelection = (questionId) => {
    const newSelected = new Set(selectedQuestions);
    if (newSelected.has(questionId)) {
      newSelected.delete(questionId);
    } else {
      newSelected.add(questionId);
    }
    setSelectedQuestions(newSelected);
    setShowBulkActions(newSelected.size > 0);
  };

  const handleSelectAll = () => {
    const allIds = new Set(filteredQuestions.map(q => q.id));
    setSelectedQuestions(allIds);
    setShowBulkActions(true);
  };

  const handleBulkDelete = async () => {
    if (selectedQuestions.size === 0) return;
    setShowDeleteConfirm(true);
  };

  const confirmBulkDelete = async () => {
    setAnimatingQuestions(new Set(selectedQuestions));
    setAnimationType('delete');
    setShowDeleteConfirm(false);

    await new Promise(resolve => setTimeout(resolve, 600));

    try {
      for (const questionId of selectedQuestions) {
        const question = questions.find(item => item.id === questionId);
        await deleteQuestion(questionId);
        setQuestions(current => current.filter(item => item.id !== questionId));
        try {
          await deleteManagedImage(question?.imageUrl);
        } catch {
          alert(`Question ${questionId} was deleted, but its image could not be removed.`);
        }
      }
      setSelectedQuestions(new Set());
      setShowBulkActions(false);
      setIsSelectionMode(false);
      setAnimatingQuestions(new Set());
      setAnimationType(null);
    } catch (error) {
      alert(error.message || 'Failed to delete questions.');
      setAnimatingQuestions(new Set());
      setAnimationType(null);
    }
  };

  const handleBulkMove = async (newTopic) => {
    if (selectedQuestions.size === 0) return;

    setAnimatingQuestions(new Set(selectedQuestions));
    setAnimationType('move');
    setShowMoveModal(false);

    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      for (const questionId of selectedQuestions) {
        const question = questions.find(q => q.id === questionId);
        if (question) {
          await updateQuestion(questionId, { ...question, topic: newTopic });
        }
      }
      const newQuestions = await getQuestions();
      setQuestions(newQuestions);
      setSelectedQuestions(new Set());
      setShowBulkActions(false);
      setIsSelectionMode(false);
      setAnimatingQuestions(new Set());
      setAnimationType(null);
    } catch (error) {
      alert(error.message || 'Failed to move questions.');
      setAnimatingQuestions(new Set());
      setAnimationType(null);
    }
  };

  const handleOptionChange = (index, value) => {
    const newOptions = [...formData.options];
    newOptions[index] = value;
    setFormData({ ...formData, options: newOptions });
  };

  const getTopicPath = (topicId) => {
    const path = [];
    let current = topics.find(t => t.id === topicId);
    while (current) {
      path.unshift(current.name || current.id);
      current = topics.find(t => t.id === current.parentId);
    }
    return path.join(' → ');
  };

  const filterTopics = (searchTerm) => {
    if (!searchTerm) return [];
    const lowerSearch = searchTerm.toLowerCase();
    return topics.filter(topic =>
      topic.isLast !== false &&
      ((topic.name || topic.id).toLowerCase().includes(lowerSearch) ||
      topic.id.toLowerCase().includes(lowerSearch))
    );
  };

  const handleFormTopicSelect = (topicId) => {
    setFormData({ ...formData, topic: topicId });
    setTopicSearch(getTopicPath(topicId));
    setShowTopicDropdown(false);
  };

  const parseBulkQuestions = (text) => {
    const questions = [];

    const questionBlocks = text.split(/question:/i);

    for (let i = 0; i < questionBlocks.length; i++) {
      const block = questionBlocks[i];

      if (!block.trim()) continue;

      const lines = block.split('\n');

      const question = {
        text: '',
        options: ['', '', '', ''],
        correctOption: null,
        explanation: '',
        hint: '',
        difficulty: 'medium',
        topic: '',
        status: 'published',
        imageUrl: ''
      };

      let inQuestionText = true;
      let questionText = '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        const lowerLine = trimmedLine.toLowerCase();

        if (lowerLine.startsWith('a)') || lowerLine.startsWith('b)') || lowerLine.startsWith('c)') || lowerLine.startsWith('d)')) {
          inQuestionText = false;
          const optionIndex = lowerLine.charAt(0).charCodeAt(0) - 97;
          if (optionIndex >= 0 && optionIndex < 4) {
            question.options[optionIndex] = trimmedLine.substring(2).trim();
          }
        } else if (lowerLine.startsWith('correct:') || lowerLine.startsWith('answer:')) {
          inQuestionText = false;
          const answer = trimmedLine.replace(/^(correct:|answer:)\s*/i, '').trim();
          const letter = answer.match(/^[a-d]$/i)?.[0]?.toLowerCase();
          if (letter) {
            question.correctOption = letter.charCodeAt(0) - 97;
          } else {
            question.correctOption = /^[0-3]$/.test(answer) ? Number(answer) : null;
          }
        } else if (lowerLine.startsWith('explanation:') || lowerLine.startsWith('exp:')) {
          inQuestionText = false;
          question.explanation = trimmedLine.replace(/^(explanation:|exp:)\s*/i, '').trim();
        } else if (lowerLine.startsWith('hint:')) {
          inQuestionText = false;
          question.hint = trimmedLine.replace(/^hint:\s*/i, '').trim();
        } else if (lowerLine.startsWith('difficulty:') || lowerLine.startsWith('diff:')) {
          inQuestionText = false;
          const diff = trimmedLine.replace(/^(difficulty:|diff:)\s*/i, '').trim().toLowerCase();
          question.difficulty = diff;
        } else if (inQuestionText) {
          questionText += line + '\n';
        }
      }

      question.text = questionText.trim();

      questions.push(question);
    }

    return questions;
  };

  const handleBulkImport = () => {
    try {
      const selectedTopic = topics.find(topic => topic.id === selectedBulkTopic);
      if (!selectedTopic || selectedTopic.isLast === false) {
        throw new Error('Select an existing leaf topic.');
      }
      const parsed = parseBulkQuestions(bulkText);
      if (!parsed.length) {
        throw new Error('Enter at least one question.');
      }
      parsed.forEach((question, index) => {
        try {
          validateQuestion({ ...question, topic: selectedBulkTopic });
        } catch (error) {
          throw new Error(`Question ${index + 1}: ${error.message}`, { cause: error });
        }
      });
      setParsedQuestions(parsed);
      setShowPreview(true);
    } catch (error) {
      alert(error.message || 'Could not parse questions.');
    }
  };

  const handleConfirmBulkImport = async () => {
    const selectedTopic = topics.find(t => t.id === selectedBulkTopic);
    if (!selectedTopic || selectedTopic.isLast === false) {
      alert('Select an existing leaf topic.');
      return;
    }

    let importedCount = 0;
    try {
      const validatedQuestions = parsedQuestions.map(question =>
        validateQuestion({ ...question, topic: selectedBulkTopic }));
      for (const question of validatedQuestions) {
        let generatedImageUrl = '';
        if (question.text) {
          const latexMatches = detectLatexInText(question.text);
          if (latexMatches.length > 0) {
            const latexImage = await processTextWithLatex(question.text);
            if (latexImage) {
              const imagePath = `questions/${crypto.randomUUID()}/latex_${crypto.randomUUID()}.png`;
              question.imageUrl = await uploadImageToStorage(latexImage, imagePath);
              generatedImageUrl = question.imageUrl;
              question.text = '';
            }
          }
        }

        try {
          await createQuestion(question);
        } catch (error) {
          if (generatedImageUrl) {
            try {
              await deleteManagedImage(generatedImageUrl);
            } catch {
              alert('An imported question failed, and its generated image could not be removed.');
            }
          }
          throw error;
        }
        importedCount += 1;
      }
      const newQuestions = await getQuestions();
      setQuestions(newQuestions);
      setParsedQuestions([]);
      setShowPreview(false);
      setShowCreateForm(false);
      alert(`Successfully imported ${importedCount} questions.`);
    } catch (error) {
      if (importedCount === parsedQuestions.length) {
        setParsedQuestions([]);
        setShowPreview(false);
      } else if (importedCount > 0) {
        setParsedQuestions(current => current.slice(importedCount));
      }
      alert(importedCount === parsedQuestions.length
        ? `All ${importedCount} questions were saved, but the list could not refresh. Reload the page.`
        : `Imported ${importedCount} questions before the import stopped: ${error.message}`);
    }
  };

  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-white" role="alert">
        <p>{loadError}</p>
        <button type="button" onClick={() => window.location.reload()} className="px-5 py-3 rounded-xl bg-blue-600">
          Retry
        </button>
      </div>
    );
  }

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
              Questions
              <span className={`text-sm font-normal ${currentTheme.textSecondary} ml-2`}>
                ({questions.length} total)
              </span>
            </h1>
            <div className="flex items-center gap-2">
              {isSelectionMode ? (
                <button
                  onClick={() => {
                    setIsSelectionMode(false);
                    setSelectedQuestions(new Set());
                    setShowBulkActions(false);
                  }}
                  className={`flex items-center gap-2 px-4 py-2.5 bg-white/10 backdrop-blur-xl border border-white/20 ${currentTheme.text} rounded-2xl font-medium hover:bg-white/20 transition-all shadow-lg`}
                >
                  <X className="w-4 h-4" />
                  <span className="hidden sm:inline">Cancel</span>
                </button>
              ) : (
                <button
                  onClick={() => setIsSelectionMode(true)}
                  className={`flex items-center gap-2 px-4 py-2.5 bg-white/10 backdrop-blur-xl border border-white/20 ${currentTheme.text} rounded-2xl font-medium hover:bg-white/20 transition-all shadow-lg`}
                >
                  <ListChecks className="w-4 h-4" />
                  <span className="hidden sm:inline">Select</span>
                </button>
              )}
              <button
                onClick={() => setShowCreateForm(true)}
                className={`flex items-center gap-2 bg-white/10 backdrop-blur-xl border border-white/20 ${currentTheme.text} px-4 py-2.5 rounded-2xl font-medium hover:bg-white/20 transition-all shadow-lg hover:shadow-xl animate-scale-in`}
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Add Question</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {(showCreateForm || editingQuestion) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className={`${currentTheme.card} backdrop-blur-xl rounded-3xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-white/10 shadow-2xl animate-scale-in`}>
            <div className="flex items-center justify-between mb-6">
              <h2 className={`text-xl font-semibold ${currentTheme.text}`}>
                {editingQuestion ? 'Edit' : 'Create'}
              </h2>
              <button
                onClick={discardForm}
                className={`${currentTheme.textSecondary} hover:${currentTheme.text} transition-colors`}
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex items-center justify-between mb-6 p-4 bg-white/10 rounded-2xl">
              <p className={`${currentTheme.text} font-medium`}>Bulk Import</p>
              <button
                onClick={() => setIsBulkMode(!isBulkMode)}
                className={`relative w-14 h-8 rounded-full transition-colors duration-300 ${
                  isBulkMode ? 'bg-blue-500' : 'bg-white/20'
                }`}
              >
                <div
                  className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow-lg transition-transform duration-300 ${
                    isBulkMode ? 'translate-x-7' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {!isBulkMode ? (
              <div className="space-y-4">
                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Question</label>
                  <textarea
                    value={formData.text}
                    onChange={(e) => handleTextChange(e.target.value)}
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                    rows={3}
                  />
                </div>

                {showLatexPreview && (
                  <LatexPreviewCard text={formData.text} />
                )}

                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Upload Image</label>
                  <div className="flex gap-3">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files[0];
                        if (file) handleImageUpload(file);
                      }}
                      disabled={isUploading}
                      className="hidden"
                      id="image-upload"
                    />
                    <label
                      htmlFor="image-upload"
                      className={`flex items-center gap-2 px-4 py-2 bg-blue-500/20 border border-blue-500/50 rounded-xl ${currentTheme.text} hover:bg-blue-500/30 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {isUploading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ImageIcon className="w-4 h-4" />
                      )}
                      <span className="text-sm">Choose Image</span>
                    </label>
                    {imagePreview && (
                      <button
                        onClick={handleRemoveImage}
                        className={`flex items-center gap-2 px-4 py-2 bg-red-500/20 border border-red-500/50 rounded-xl text-red-400 hover:bg-red-500/30 transition-all`}
                      >
                        <X className="w-4 h-4" />
                        <span className="text-sm">Remove</span>
                      </button>
                    )}
                  </div>
                  {imagePreview && (
                    <div className="mt-3">
                      <img
                        src={imagePreview}
                        alt="Question image"
                        className="max-w-full h-auto rounded-xl border border-white/20"
                      />
                    </div>
                  )}
                </div>

                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Options</label>
                  {formData.options.map((option, index) => (
                    <div key={index} className="flex gap-3 mb-3">
                      <span className={`${currentTheme.textSecondary} w-8 mt-3 font-medium`}>{['A)', 'B)', 'C)', 'D)'][index]}</span>
                      <input
                        type="text"
                        value={option}
                        onChange={(e) => handleOptionChange(index, e.target.value)}
                        className="flex-1 px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                      />
                      <input
                        type="radio"
                        name="correctOption"
                        checked={formData.correctOption === index}
                        onChange={() => setFormData({ ...formData, correctOption: index })}
                        className="mt-3 w-5 h-5 accent-blue-500"
                      />
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Difficulty</label>
                    <select
                      value={formData.difficulty}
                      onChange={(e) => setFormData({ ...formData, difficulty: e.target.value })}
                      className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                    >
                      <option value="easy" className="bg-slate-900">Easy</option>
                      <option value="medium" className="bg-slate-900">Medium</option>
                      <option value="hard" className="bg-slate-900">Hard</option>
                    </select>
                  </div>
                  <div>
                    <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Status</label>
                    <select
                      value={formData.status}
                      onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                      className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                    >
                      <option value="draft" className="bg-slate-900">Draft</option>
                      <option value="published" className="bg-slate-900">Published</option>
                    </select>
                  </div>
                  <div>
                    <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Topic</label>
                    <div className="relative">
                      <input
                        type="text"
                        value={topicSearch}
                        onChange={(e) => {
                          setTopicSearch(e.target.value);
                          setFormData(current => ({ ...current, topic: '' }));
                          setShowTopicDropdown(true);
                        }}
                        onFocus={() => setShowTopicDropdown(true)}
                        onBlur={() => setTimeout(() => setShowTopicDropdown(false), 200)}
                        className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                      />
                      {showTopicDropdown && (
                        <div className="absolute z-10 w-full mt-2 bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl max-h-60 overflow-y-auto shadow-xl">
                          {filterTopics(topicSearch).length === 0 ? (
                            <div className={`p-4 ${currentTheme.textSecondary}`}>No topics</div>
                          ) : (
                            filterTopics(topicSearch).map(topic => (
                              <div
                                key={topic.id}
                                onClick={() => handleFormTopicSelect(topic.id)}
                                className="p-4 hover:bg-white/20 cursor-pointer border-b border-white/10 last:border-0 transition-colors"
                              >
                                <div className={`${currentTheme.text} font-medium`}>{topic.name || topic.id}</div>
                                <div className={`text-xs ${currentTheme.textSecondary} mt-1`}>{getTopicPath(topic.id)}</div>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Explanation</label>
                  <textarea
                    value={formData.explanation}
                    onChange={(e) => setFormData({ ...formData, explanation: e.target.value })}
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                    rows={2}
                  />
                </div>

                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Hint</label>
                  <input
                    type="text"
                    value={formData.hint}
                    onChange={(e) => setFormData({ ...formData, hint: e.target.value })}
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  />
                </div>

                <button
                  onClick={editingQuestion ? handleUpdate : handleCreate}
                  className="w-full flex items-center justify-center gap-2 bg-white/10 backdrop-blur-xl border border-white/20 text-white px-6 py-4 rounded-2xl font-medium hover:bg-white/20 transition-all shadow-lg hover:shadow-xl"
                >
                  <Save className="w-5 h-5" />
                  {editingQuestion ? 'Update' : 'Create'}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className={`block text-sm ${currentTheme.textSecondary} font-medium`}>Questions</label>
                  <button
                    onClick={() => {
                      const template = `Question: [Your question text here]
A) Option A
B) Option B
C) Option C
D) Option D
Correct: B
Explanation: [Explanation of why B is correct]
Hint: [Optional hint for the user]
Difficulty: easy

Question: [Next question text]
A) Option A
B) Option B
C) Option C
D) Option D
Correct: A
Explanation: [Explanation]
Hint: [Hint]
Difficulty: medium`;

                      const textArea = document.createElement('textarea');
                      textArea.value = template;
                      textArea.style.position = 'fixed';
                      textArea.style.left = '-999999px';
                      textArea.style.top = '-999999px';
                      document.body.appendChild(textArea);
                      textArea.focus();
                      textArea.select();

                      try {
                        const successful = document.execCommand('copy');
                        document.body.removeChild(textArea);
                        if (successful) {
                          setTemplateCopied(true);
                          setTimeout(() => setTemplateCopied(false), 2000);
                        } else {
                          alert('Could not copy the template.');
                        }
                      } catch {
                        document.body.removeChild(textArea);
                        alert('Could not copy the template.');
                      }
                    }}
                    className={`flex items-center gap-2 ${currentTheme.textSecondary} hover:${currentTheme.text} text-sm transition-colors`}
                  >
                    {templateCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                    {templateCopied ? 'Copied!' : 'Copy Template'}
                  </button>
                </div>
                <div>
                  <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Topic for all questions</label>
                  <div className="relative">
                    <input
                      type="text"
                      value={bulkTopicSearch}
                      onChange={(e) => {
                        setBulkTopicSearch(e.target.value);
                        setSelectedBulkTopic('');
                        setShowBulkTopicDropdown(true);
                      }}
                      onFocus={() => setShowBulkTopicDropdown(true)}
                      onBlur={() => setTimeout(() => setShowBulkTopicDropdown(false), 200)}
                      className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                    />
                    {showBulkTopicDropdown && (
                      <div className="absolute z-10 w-full mt-2 bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl max-h-60 overflow-y-auto shadow-xl">
                        {filterTopics(bulkTopicSearch).length === 0 ? (
                          <div className={`p-4 ${currentTheme.textSecondary}`}>No topics</div>
                        ) : (
                          filterTopics(bulkTopicSearch).map(topic => (
                            <div
                              key={topic.id}
                              onClick={() => {
                                setSelectedBulkTopic(topic.id);
                                setBulkTopicSearch(topic.name || topic.id);
                                setShowBulkTopicDropdown(false);
                              }}
                              className="p-4 hover:bg-white/20 cursor-pointer border-b border-white/10 last:border-0 transition-colors"
                            >
                              <div className={`${currentTheme.text} font-medium`}>{topic.name || topic.id}</div>
                              <div className={`text-xs ${currentTheme.textSecondary} mt-1`}>{getTopicPath(topic.id)}</div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all font-mono text-sm"
                    rows={12}
                  />
                </div>

                <button
                  onClick={handleBulkImport}
                  className="w-full flex items-center justify-center gap-2 bg-white/10 backdrop-blur-xl border border-white/20 text-white px-6 py-4 rounded-2xl font-medium hover:bg-white/20 transition-all shadow-lg hover:shadow-xl"
                >
                  <Upload className="w-5 h-5" />
                  Parse
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showPreview && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className={`${currentTheme.card} backdrop-blur-xl rounded-3xl p-6 max-w-4xl w-full max-h-[80vh] overflow-y-auto border border-white/10 shadow-2xl`}>
            <div className="flex items-center justify-between mb-6">
              <h2 className={`text-xl font-semibold ${currentTheme.text}`}>
                {parsedQuestions.length} questions
              </h2>
              <button
                onClick={() => setShowPreview(false)}
                className={`${currentTheme.textSecondary} hover:${currentTheme.text} transition-colors`}
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="space-y-4 mb-6">
              {parsedQuestions.map((q, index) => (
                <div key={index} className="bg-white/10 rounded-2xl p-4 border border-white/10">
                  {q.imageUrl ? (
                    <img
                      src={q.imageUrl}
                      alt="Question"
                      className="max-w-xs h-auto rounded-xl border border-white/20 mb-2"
                    />
                  ) : q.text ? (
                    <LatexPreviewCard text={q.text} />
                  ) : null}
                  <div className="space-y-1 mb-2">
                    {q.options.filter(o => o).map((opt, i) => (
                      <p key={i} className={`${currentTheme.textSecondary} text-sm`}>
                        {['A)', 'B)', 'C)', 'D)'][i]} {opt}
                      </p>
                    ))}
                  </div>
                  <p className={`${currentTheme.textSecondary} text-sm`}>
                    Correct: {['A', 'B', 'C', 'D'][q.correctOption]}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowPreview(false)}
                className="flex-1 px-6 py-3 bg-white/10 text-white rounded-2xl hover:bg-white/20 transition-all shadow-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmBulkImport}
                className="flex-1 flex items-center justify-center gap-2 bg-white/10 backdrop-blur-xl border border-white/20 text-white px-6 py-3 rounded-2xl hover:bg-white/20 transition-all shadow-lg hover:shadow-xl"
              >
                <Check className="w-5 h-5" />
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      <motion.div
          layout
          className={`min-h-screen ${
            selectedTopicFilter
              ? 'w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col lg:flex-row justify-start items-start gap-8'
              : 'flex justify-center items-center px-4 py-6'
          }`}
        >
          <motion.div
            layout
            className={`${currentTheme.card} backdrop-blur-xl rounded-2xl p-4 border border-white/10 shadow-lg ${
              selectedTopicFilter ? 'w-full max-w-[320px] shrink-0 lg:sticky lg:top-4' : 'max-w-2xl w-full'
            }`}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className={`text-lg font-semibold ${currentTheme.text}`}>Topics</h3>
              <button
                onClick={() => setShowTopicTree(!showTopicTree)}
                className={`p-2 ${currentTheme.textSecondary} hover:bg-white/20 rounded-lg transition-colors`}
              >
                <Filter className="w-4 h-4" />
              </button>
            </div>

            {showTopicTree && (
              <>
                <div className="hidden lg:block space-y-1 max-h-[calc(100vh-200px)] overflow-y-auto overflow-x-hidden">
                  {topicTree.map(topic => renderTopicTreeNode(topic))}
                </div>

                <div className="lg:hidden">
                  {mobileTopicPath.length > 0 && (
                    <button
                      onClick={handleMobileTopicBack}
                      className="flex items-center gap-1.5 p-2 rounded-lg bg-white/10 border border-white/20 hover:bg-white/20 transition-all mb-2 self-start"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span className={`${currentTheme.text} text-xs`}>Back</span>
                    </button>
                  )}

                  <div className="space-y-2 max-h-[50vh] overflow-y-auto overflow-x-hidden">
                    {getCurrentMobileTopics().map(topic => {
                      const isLast = topic.isLast !== false;

                      return (
                        <button
                          key={topic.id}
                          onClick={() => handleMobileTopicClick(topic)}
                          className={`w-full text-left p-3 rounded-xl transition-all overflow-hidden ${
                            selectedTopicFilter === topic.id
                              ? 'bg-blue-500/20 border-2 border-blue-500/50'
                              : 'bg-white/10 border border-white/20 hover:bg-white/20'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3 overflow-hidden">
                            <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
                              {!isLast ? (
                                <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                              ) : (
                                <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                              )}
                              <span className={`${currentTheme.text} font-medium text-sm line-clamp-2 break-words leading-tight`}>{topic.name || topic.id}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 whitespace-nowrap text-right">
                              <span className={`text-sm font-semibold ${currentTheme.textSecondary}`}>{topic.questionCount || 0}</span>
                              {!isLast && (
                                <ChevronRight className="w-4 h-4 text-white/50 shrink-0" />
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {getCurrentMobileTopics().length === 0 && (
                    <div className={`text-center py-4 ${currentTheme.textSecondary} text-sm`}>
                      No topics
                    </div>
                  )}
                </div>
              </>
            )}
          </motion.div>

          <AnimatePresence>
            {selectedTopicFilter && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="flex-1 min-w-0"
              >
                <div className={`${currentTheme.card} backdrop-blur-xl rounded-2xl p-4 mb-4 border border-white/10 shadow-lg`}>
                  <div className="flex gap-3">
                    <div className="flex-1 relative">
                      <Search className={`absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 ${currentTheme.textSecondary}`} />
                      <input
                        type="text"
                        placeholder="Search questions..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-12 pr-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                      />
                    </div>
                    <button
                      onClick={() => setSelectedTopicFilter('')}
                      className={`flex items-center gap-2 px-4 py-3 bg-blue-500/20 border border-blue-500/50 rounded-2xl ${currentTheme.text} hover:bg-blue-500/30 transition-all text-sm`}
                    >
                      <X className="w-4 h-4" />
                      <span className="hidden sm:inline">Clear</span>
                    </button>
                  </div>
                </div>

                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-400"></div>
                  </div>
                ) : filteredQuestions.length === 0 ? (
                  <div className={`text-center py-12 ${currentTheme.textSecondary}`}>
                    No questions in this topic
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredQuestions.map((question, index) => (
                      <div
                        key={question.id}
                        className={`${currentTheme.card} backdrop-blur-xl rounded-2xl p-4 sm:p-5 border border-white/10 hover:bg-white/10 transition-all shadow-lg hover:shadow-xl animate-fade-in ${
                          animatingQuestions.has(question.id)
                            ? animationType === 'delete'
                              ? 'animate-fly-to-trash'
                              : 'animate-fly-to-target'
                            : ''
                        }`}
                        style={{ animationDelay: `${index * 50}ms` }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
                            {isSelectionMode && (
                              <button
                                onClick={() => toggleQuestionSelection(question.id)}
                                className="p-2 rounded-lg transition-colors mt-0.5 flex-shrink-0"
                              >
                                {selectedQuestions.has(question.id) ? (
                                  <CheckSquare className="w-5 h-5 text-blue-400" />
                                ) : (
                                  <Square className="w-5 h-5 text-slate-400" />
                                )}
                              </button>
                            )}
                            <div className="flex-1 min-w-0">
                              {question.imageUrl ? (
                                <img
                                  src={question.imageUrl}
                                  alt="Question"
                                  className="max-w-[200px] sm:max-w-xs h-auto rounded-xl border border-white/20 mb-2 sm:mb-3"
                                />
                              ) : question.text ? (
                                <p className={`${currentTheme.text} font-medium text-sm sm:text-base mb-2 sm:mb-3 line-clamp-3`}>
                                  {question.text}
                                </p>
                              ) : null}
                              <div className="flex flex-wrap gap-2">
                                <span className="px-2.5 py-1 sm:px-3 sm:py-1.5 bg-white/10 text-white/70 rounded-xl text-xs sm:text-sm font-medium">
                                  {question.topic || 'Unknown'}
                                </span>
                                <span className="px-2.5 py-1 sm:px-3 sm:py-1.5 bg-white/5 text-white/50 rounded-xl text-xs sm:text-sm font-medium">
                                  {question.difficulty || 'Medium'}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2 flex-shrink-0">
                            <button
                              onClick={() => startEdit(question)}
                              className={`p-2 sm:p-2.5 ${currentTheme.textSecondary} hover:bg-white/20 rounded-xl transition-colors hover:scale-110 active:scale-95`}
                            >
                              <SquarePen className="w-4 sm:w-5 h-4 sm:h-5" />
                            </button>
                            <button
                              onClick={() => handleDelete(question.id)}
                              className="p-2 sm:p-2.5 text-red-400 hover:bg-red-500/20 rounded-xl transition-colors hover:scale-110 active:scale-95"
                            >
                              <Trash2 className="w-4 sm:w-5 h-4 sm:h-5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {isSelectionMode && showBulkActions && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900/95 backdrop-blur-xl border border-white/10 shadow-2xl rounded-2xl px-3 sm:px-5 py-2 sm:py-3 z-50 animate-slide-up">
            <div className="flex items-center justify-between gap-2 sm:gap-4">
              <div className="flex items-center gap-2 sm:gap-3">
                <span className={`${currentTheme.text} font-medium text-xs sm:text-sm`}>
                  {selectedQuestions.size} selected
                </span>
                <button
                  onClick={handleSelectAll}
                  className={`px-2 sm:px-3 py-1 sm:py-1.5 bg-white/10 border border-white/20 rounded-xl ${currentTheme.text} hover:bg-white/20 transition-all text-xs`}
                >
                  Select All
                </button>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <button
                  onClick={() => setShowMoveModal(true)}
                  className={`flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 bg-white/10 border border-white/20 rounded-xl ${currentTheme.text} hover:bg-white/20 transition-all text-xs`}
                >
                  <Folder className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
                  <span className="hidden sm:inline">Move</span>
                </button>
                <button
                  onClick={handleBulkDelete}
                  className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 bg-red-500/20 border border-red-500/50 text-red-400 rounded-xl hover:bg-red-500/30 transition-all text-xs"
                >
                  <Trash2 className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
                  <span className="hidden sm:inline">Delete</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className={`${currentTheme.card} backdrop-blur-xl rounded-3xl p-6 max-w-md w-full border border-white/10 shadow-2xl animate-scale-in`}>
              <div className="flex items-center justify-between mb-6">
                <h2 className={`text-xl font-semibold ${currentTheme.text}`}>
                  Delete Questions
                </h2>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className={`${currentTheme.textSecondary} hover:${currentTheme.text} transition-colors`}
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="mb-6">
                <p className={`${currentTheme.text} mb-2`}>
                  Are you sure you want to delete {selectedQuestions.size} question{selectedQuestions.size > 1 ? 's' : ''}?
                </p>
                <p className={`${currentTheme.textSecondary} text-sm`}>
                  This action cannot be undone.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-6 py-3 bg-white/10 text-white rounded-2xl hover:bg-white/20 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmBulkDelete}
                  className="flex-1 px-6 py-3 bg-red-500 text-white rounded-2xl hover:bg-red-600 transition-all"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {showMoveModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className={`${currentTheme.card} backdrop-blur-xl rounded-3xl p-6 max-w-md w-full border border-white/10 shadow-2xl animate-scale-in`}>
              <div className="flex items-center justify-between mb-6">
                <h2 className={`text-xl font-semibold ${currentTheme.text}`}>
                  Move Questions
                </h2>
                <button
                  onClick={() => setShowMoveModal(false)}
                  className={`${currentTheme.textSecondary} hover:${currentTheme.text} transition-colors`}
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="mb-6">
                <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Select Topic</label>
                <div className="relative">
                  <input
                    type="text"
                    value={moveTopicSearch}
                    onChange={(e) => {
                      setMoveTopicSearch(e.target.value);
                      setShowMoveTopicDropdown(true);
                    }}
                    onFocus={() => setShowMoveTopicDropdown(true)}
                    onBlur={() => setTimeout(() => setShowMoveTopicDropdown(false), 200)}
                    placeholder="Search topics by name or ID..."
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  />
                  {showMoveTopicDropdown && (
                    <div className="absolute z-10 w-full mt-2 bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl max-h-60 overflow-y-auto shadow-xl">
                      {filterTopics(moveTopicSearch).length === 0 ? (
                        <div className={`p-4 ${currentTheme.textSecondary}`}>No topics found</div>
                      ) : (
                        filterTopics(moveTopicSearch).map(topic => (
                          <div
                            key={topic.id}
                            onClick={() => {
                              handleBulkMove(topic.id);
                              setMoveTopicSearch(topic.name || topic.id);
                              setShowMoveTopicDropdown(false);
                            }}
                            className="p-4 hover:bg-white/20 cursor-pointer border-b border-white/10 last:border-0 transition-colors"
                          >
                            <div className={`${currentTheme.text} font-medium`}>{topic.name || topic.id}</div>
                            <div className={`text-xs ${currentTheme.textSecondary} mt-1`}>ID: {topic.id}</div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>

              <button
                onClick={() => setShowMoveModal(false)}
                className="w-full px-6 py-3 bg-white/10 text-white rounded-2xl hover:bg-white/20 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {isSelectionMode && showBulkActions && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900/95 backdrop-blur-xl border border-white/10 shadow-2xl rounded-2xl px-3 sm:px-5 py-2 sm:py-3 z-50 animate-slide-up">
            <div className="flex items-center justify-between gap-2 sm:gap-4">
              <div className="flex items-center gap-2 sm:gap-3">
                <span className={`${currentTheme.text} font-medium text-xs sm:text-sm`}>
                  {selectedQuestions.size} selected
                </span>
                <button
                  onClick={handleSelectAll}
                  className={`px-2 sm:px-3 py-1 sm:py-1.5 bg-white/10 border border-white/20 rounded-xl ${currentTheme.text} hover:bg-white/20 transition-all text-xs`}
                >
                  Select All
                </button>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <button
                  onClick={() => setShowMoveModal(true)}
                  className={`flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 bg-white/10 border border-white/20 rounded-xl ${currentTheme.text} hover:bg-white/20 transition-all text-xs`}
                >
                  <Folder className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
                  <span className="hidden sm:inline">Move</span>
                </button>
                <button
                  onClick={handleBulkDelete}
                  className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 bg-red-500/20 border border-red-500/50 text-red-400 rounded-xl hover:bg-red-500/30 transition-all text-xs"
                >
                  <Trash2 className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
                  <span className="hidden sm:inline">Delete</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className={`${currentTheme.card} backdrop-blur-xl rounded-3xl p-6 max-w-md w-full border border-white/10 shadow-2xl animate-scale-in`}>
              <div className="flex items-center justify-between mb-6">
                <h2 className={`text-xl font-semibold ${currentTheme.text}`}>
                  Delete Questions
                </h2>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className={`${currentTheme.textSecondary} hover:${currentTheme.text} transition-colors`}
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="mb-6">
                <p className={`${currentTheme.text} mb-2`}>
                  Are you sure you want to delete {selectedQuestions.size} question{selectedQuestions.size > 1 ? 's' : ''}?
                </p>
                <p className={`${currentTheme.textSecondary} text-sm`}>
                  This action cannot be undone.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-6 py-3 bg-white/10 text-white rounded-2xl hover:bg-white/20 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmBulkDelete}
                  className="flex-1 px-6 py-3 bg-red-500 text-white rounded-2xl hover:bg-red-600 transition-all"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {showMoveModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className={`${currentTheme.card} backdrop-blur-xl rounded-3xl p-6 max-w-md w-full border border-white/10 shadow-2xl animate-scale-in`}>
              <div className="flex items-center justify-between mb-6">
                <h2 className={`text-xl font-semibold ${currentTheme.text}`}>
                  Move Questions
                </h2>
                <button
                  onClick={() => setShowMoveModal(false)}
                  className={`${currentTheme.textSecondary} hover:${currentTheme.text} transition-colors`}
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="mb-6">
                <label className={`block text-sm ${currentTheme.textSecondary} mb-2 font-medium`}>Select Topic</label>
                <div className="relative">
                  <input
                    type="text"
                    value={moveTopicSearch}
                    onChange={(e) => {
                      setMoveTopicSearch(e.target.value);
                      setShowMoveTopicDropdown(true);
                    }}
                    onFocus={() => setShowMoveTopicDropdown(true)}
                    onBlur={() => setTimeout(() => setShowMoveTopicDropdown(false), 200)}
                    placeholder="Search topics by name or ID..."
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  />
                  {showMoveTopicDropdown && (
                    <div className="absolute z-10 w-full mt-2 bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl max-h-60 overflow-y-auto shadow-xl">
                      {filterTopics(moveTopicSearch).length === 0 ? (
                        <div className={`p-4 ${currentTheme.textSecondary}`}>No topics found</div>
                      ) : (
                        filterTopics(moveTopicSearch).map(topic => (
                          <div
                            key={topic.id}
                            onClick={() => {
                              handleBulkMove(topic.id);
                              setMoveTopicSearch(topic.name || topic.id);
                              setShowMoveTopicDropdown(false);
                            }}
                            className="p-4 hover:bg-white/20 cursor-pointer border-b border-white/10 last:border-0 transition-colors"
                          >
                            <div className={`${currentTheme.text} font-medium`}>{topic.name || topic.id}</div>
                            <div className={`text-xs ${currentTheme.textSecondary} mt-1`}>ID: {topic.id}</div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>

              <button
                onClick={() => setShowMoveModal(false)}
                className="w-full px-6 py-3 bg-white/10 text-white rounded-2xl hover:bg-white/20 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
    </div>
  );
}
