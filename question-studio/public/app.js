import { questionLanguages, t } from './i18n.js';

const root = document.getElementById('app');
const cloudTransport = Boolean(globalThis.google?.script?.run);
const pollInterval = cloudTransport ? 30000 : 2000;
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 });
const number = new Intl.NumberFormat('ru-RU');
const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const selectedTopics = new Set();
const selectedQuestions = new Set();
const controllers = new Set();
const signatures = {};
let state = null;
let csrfToken = null;
let initialized = false;
let pending = false;
let online = false;
let stopped = false;
let pollTimer;
let failures = 0;
let questionLanguage = 'kk';
let questionIndex = 0;
let currentQuestionId = null;
let questionFilter = 'all';

function element(tag, className = '', content = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== '') node.textContent = String(content);
  return node;
}

function icon(name) {
  const paths = {
    play: 'M8 5v14l11-7z',
    pause: 'M8 5v14M16 5v14',
    left: 'm14 6-6 6 6 6',
    right: 'm10 6 6 6-6 6',
    menu: 'M4 6h16M4 12h16M4 18h16',
    close: 'm6 6 12 12M18 6 6 18',
    brand: 'M4 20 12 4l8 16M7 14h10',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  svg.append(path);
  return svg;
}

function button(label, handler, className = 'button') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function field(labelText, control) {
  const label = element('label', 'field');
  label.append(element('span', '', labelText), control);
  return label;
}

function input(type, options = {}) {
  const node = element('input', 'input');
  node.type = type;
  Object.assign(node, options);
  return node;
}

function select(entries, labelText) {
  const node = element('select', 'input');
  node.setAttribute('aria-label', labelText);
  for (const [value, label] of entries) {
    const option = element('option', '', label);
    option.value = value;
    node.append(option);
  }
  return node;
}

function replaceWhenChanged(key, target, data, build) {
  const signature = JSON.stringify(data);
  if (signatures[key] === signature) return;
  signatures[key] = signature;
  target.replaceChildren(...build());
}

const studio = element('div', 'studio');
const sidebar = element('aside', 'sidebar');
sidebar.setAttribute('aria-label', t('topics'));
const brand = element('div', 'brand');
const brandIcon = icon('brand');
brandIcon.classList.add('brand-mark');
brand.append(brandIcon, element('span', '', t('brand')));
const closeTopics = button('', () => studio.classList.remove('topics-open'), 'button icon mobile-toggle');
closeTopics.setAttribute('aria-label', t('closeTopics'));
closeTopics.append(icon('close'));
brand.append(closeTopics);
const sidebarHeader = element('div', 'sidebar-header');
const topicsHeading = element('div', 'section-heading');
const topicsSelected = element('span', 'muted number');
topicsSelected.style.fontSize = '11px';
topicsHeading.append(element('h2', '', t('topics')), topicsSelected);
const search = input('search', { placeholder: t('search') });
search.setAttribute('aria-label', t('search'));
search.addEventListener('input', renderTopics);
const topicActions = element('div', 'topic-actions');
topicActions.append(
  button(t('allTopics'), () => {
    state?.topics.filter(topic => topic.eligible).forEach(topic => selectedTopics.add(topic.id));
    renderTopics();
    renderPlan();
    renderControls();
  }, 'text-button'),
  button(t('clearTopics'), () => { selectedTopics.clear(); renderTopics(); renderPlan(); renderControls(); }, 'text-button'),
);
sidebarHeader.append(topicsHeading, search, topicActions);
const topicList = element('div', 'topic-list');
const budget = element('section', 'budget');
budget.setAttribute('aria-label', t('budget'));
const budgetTitle = element('div', 'budget-title');
const budgetValue = element('span', 'number', '—');
budgetTitle.append(element('span', '', t('budget')), budgetValue);
const budgetMeter = element('div', 'budget-meter');
const budgetUsed = element('span', 'budget-used');
const budgetHeld = element('span', 'budget-held');
budgetMeter.append(budgetUsed, budgetHeld);
budgetMeter.setAttribute('aria-hidden', 'true');
const budgetSpent = element('div', 'budget-line');
const budgetReserved = element('div', 'budget-line');
const forecast = element('div', 'budget-forecast');
forecast.hidden = true;
budget.append(budgetTitle, budgetMeter, budgetSpent, budgetReserved, forecast);
sidebar.append(brand, sidebarHeader, topicList, budget);

const workspace = element('main', 'workspace');
workspace.id = 'workspace';
const workspaceHeader = element('header', 'workspace-header');
const headerTitle = element('div', 'header-title');
const mobileTopics = button('', () => studio.classList.add('topics-open'), 'button icon mobile-toggle');
mobileTopics.setAttribute('aria-label', t('mobileTopics'));
mobileTopics.append(icon('menu'));
headerTitle.append(mobileTopics, element('h1', '', t('title')));
const status = element('span', 'status');
const statusDot = element('span', 'status-dot');
const statusText = element('span', '', t('connection'));
status.append(statusDot, statusText);
workspaceHeader.append(headerTitle, status);
const workspaceBody = element('div', 'workspace-body');
const runTitle = element('h2', 'run-title', t('workspace'));
const modelLine = element('p', 'model-line', t('connection'));
const totals = element('div', 'totals');
const pipeline = element('section', 'pipeline');
pipeline.setAttribute('aria-label', t('parallelWork'));
pipeline.hidden = true;
const pipelineHeading = element('div', 'pipeline-heading');
const pipelineSummary = element('span', 'pipeline-summary number');
pipelineHeading.append(element('h2', '', t('parallelWork')), pipelineSummary);
const pipelineJobs = element('ul', 'pipeline-jobs');
pipeline.append(pipelineHeading, pipelineJobs);
const errorNotice = element('div', 'notice');
errorNotice.setAttribute('role', 'alert');
errorNotice.hidden = true;
const activityHeading = element('div', 'activity-heading');
const eventCount = element('span', 'muted');
eventCount.style.fontSize = '11px';
activityHeading.append(element('h2', '', t('activity')), eventCount);
const events = element('div', 'events');
events.setAttribute('aria-label', t('activity'));
const connection = element('div', 'connection', t('connection'));
connection.setAttribute('role', 'status');
const followLabel = element('label', 'checkbox');
const follow = input('checkbox', { checked: true });
follow.className = '';
followLabel.append(follow, element('span', '', t('follow')));
activityHeading.append(followLabel);
workspaceBody.append(runTitle, modelLine, totals, errorNotice, activityHeading, events);
const composer = element('form', 'composer');
const mode = select([['generate', t('generate')], ['parse', t('parse')]], t('mode'));
const modeRow = element('div', 'mode-row');
modeRow.append(field(t('mode'), mode));
const perTopic = input('number', { min: '10', max: '200', required: true, step: '1' });
const batchSize = input('number', { min: '1', max: '5', required: true, step: '1' });
const fields = element('div', 'field-row');
fields.append(field(t('perTopic'), perTopic), field(t('batchSize'), batchSize));
const sourceField = element('div', 'source-field');
sourceField.hidden = true;
const source = element('textarea', 'input');
source.id = 'source-text';
source.placeholder = t('sourcePlaceholder');
source.maxLength = 200000;
const sourceHeading = element('div', 'source-heading');
const sourceLabel = element('label', 'muted', t('sourceText'));
sourceLabel.htmlFor = source.id;
const fileInput = input('file', { accept: '.txt,text/plain' });
fileInput.hidden = true;
sourceHeading.append(sourceLabel, button(t('readFile'), () => fileInput.click(), 'text-button'));
sourceField.append(sourceHeading, source, fileInput);
const plan = element('p', 'plan');
const difficultyMix = element('p', 'budget-note');
const budgetNote = element('p', 'budget-note', t('budgetNote'));
const actionRow = element('div', 'action-row');
const run = button(t('run'), () => {}, 'button primary');
run.type = 'submit';
const pause = button(t('pause'), () => action('/api/pause'));
const resume = button(t('resume'), () => action('/api/resume'), 'button primary');
pause.hidden = true;
resume.hidden = true;
actionRow.append(run, pause, resume, connection);
composer.append(modeRow, fields, sourceField, plan, difficultyMix, budgetNote, actionRow);
workspace.append(workspaceHeader, pipeline, workspaceBody, composer);

const review = element('aside', 'review');
review.setAttribute('aria-label', t('review'));
const reviewHeader = element('header', 'review-header');
reviewHeader.append(element('h2', '', t('review')));
const questionCount = element('span', 'muted number');
reviewHeader.append(questionCount);
const reviewToolbar = element('div', 'review-toolbar');
const languages = element('div', 'language-tabs');
languages.setAttribute('role', 'group');
languages.setAttribute('aria-label', t('questionLanguage'));
const languageButtons = questionLanguages.map(language => {
  const item = button(language.label, () => {
    questionLanguage = language.code;
    renderQuestion();
  }, 'language-tab');
  languages.append(item);
  return { ...language, button: item };
});
const filter = select([['all', t('all')], ['validated', t('validated')], ['published', t('published')], ['failed', t('failed')]], t('filterQuestions'));
filter.addEventListener('change', () => {
  questionFilter = filter.value;
  currentQuestionId = null;
  questionIndex = 0;
  renderQuestion();
});
reviewToolbar.append(languages, filter);
const reviewBody = element('div', 'review-body');
const reviewFooter = element('footer', 'review-footer');
const pagination = element('div', 'pagination');
const position = element('span', 'number');
const paginationButtons = element('div', 'pagination-buttons');
const previous = button('', () => moveQuestion(-1), 'button icon');
previous.setAttribute('aria-label', t('previous'));
previous.append(icon('left'));
const next = button('', () => moveQuestion(1), 'button icon');
next.setAttribute('aria-label', t('next'));
next.append(icon('right'));
paginationButtons.append(previous, next);
pagination.append(position, paginationButtons);
const selectionRow = element('div', 'selection-row');
const questionSelection = element('label', 'checkbox');
const questionCheckbox = input('checkbox');
questionCheckbox.className = '';
questionCheckbox.addEventListener('change', () => {
  if (questionCheckbox.checked) selectedQuestions.add(currentQuestionId);
  else selectedQuestions.delete(currentQuestionId);
  renderControls();
});
questionSelection.append(questionCheckbox, element('span', '', t('selectQuestion')));
const selectValid = button(t('selectValid'), () => {
  for (const question of state?.questions ?? []) if (publishable(question)) selectedQuestions.add(question.id);
  renderQuestion();
}, 'text-button');
selectionRow.append(questionSelection, selectValid);
const publish = button(t('publish'), () => action('/api/publish', { ids: [...selectedQuestions] }), 'button primary');
const autoPublishNote = element('p', 'budget-note', t('autoPublish'));
autoPublishNote.hidden = true;
reviewFooter.append(pagination, selectionRow, publish, autoPublishNote);
review.append(reviewHeader, reviewToolbar, reviewBody, reviewFooter);
studio.append(sidebar, workspace, review);
root.append(studio);

function publishable(question) {
  return question.validation?.passed === true && question.status === 'draft';
}

function visibleQuestions() {
  return (state?.questions ?? []).filter(question => {
    if (questionFilter === 'validated') return publishable(question);
    if (questionFilter === 'published') return question.status === 'published';
    if (questionFilter === 'failed') return question.validation?.passed === false;
    return true;
  });
}

function displayTopicName(topic) {
  return typeof topic.name === 'string' ? topic.name : topic.name?.ru ?? topic.name?.kk ?? topic.id;
}

function renderTopics() {
  const topics = state?.topics ?? [];
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = topics.filter(topic => `${displayTopicName(topic)} ${(topic.path ?? []).join(' ')}`.toLocaleLowerCase().includes(query));
  const activeTopicIds = new Set(state?.activeTopicIds ?? (state?.activeTopicId ? [state.activeTopicId] : []));
  topicsSelected.textContent = t('selectedTopics', { count: number.format(selectedTopics.size) });
  replaceWhenChanged('topics', topicList, [filtered, [...selectedTopics], [...activeTopicIds]], () => {
    if (!filtered.length) return [element('p', 'empty', t(topics.length ? 'noMatches' : 'noTopics'))];
    return filtered.map(topic => {
      const label = element('label', `topic-item${activeTopicIds.has(topic.id) ? ' active' : ''}${topic.eligible ? '' : ' disabled'}`);
      const checkbox = input('checkbox', { checked: selectedTopics.has(topic.id), disabled: !topic.eligible || pending || state.status === 'running' });
      checkbox.className = '';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedTopics.add(topic.id);
        else selectedTopics.delete(topic.id);
        topicsSelected.textContent = t('selectedTopics', { count: number.format(selectedTopics.size) });
        renderPlan();
        renderControls();
      });
      const text = element('span');
      text.append(element('span', 'topic-name', displayTopicName(topic)));
      if (topic.path?.length) text.append(element('span', 'topic-path', topic.path.join(' / ')));
      const bottom = element('span', 'topic-bottom');
      bottom.append(element('span', '', topic.eligible ? t(topic.targetPlanned ? 'planned' : 'estimated') : topic.reason || t('topicDisabled')), element('span', 'number', t('topicProgress', { generated: topic.generated ?? 0, target: topic.target ?? 0 })));
      if (topic.rationale) label.title = topic.rationale;
      text.append(bottom);
      label.append(checkbox, text);
      return label;
    });
  });
}

function renderPipeline() {
  const progress = state?.pipeline;
  pipeline.hidden = !progress;
  if (!progress) return;
  pipelineSummary.textContent = t('parallelSummary', {
    concurrency: number.format(progress.concurrency),
    requests: number.format(progress.activeRequests),
  });
  replaceWhenChanged('pipeline', pipelineJobs, progress.jobs, () => progress.jobs.map(job => {
    const row = element('li', 'pipeline-job');
    row.dataset.stage = job.stage;
    const topic = state.topics.find(item => item.id === job.topicId);
    row.append(element('span', 'pipeline-topic', job.topicName || (topic ? displayTopicName(topic) : job.topicId)));
    const details = element('span', 'pipeline-details');
    const retryAt = new Date(job.retryAt);
    const stage = job.stage === 'waiting' && job.retryAt && !Number.isNaN(retryAt.getTime())
      ? t('parallelWaitingUntil', { time: time.format(retryAt) }) : t(`parallel_${job.stage}`);
    details.append(element('span', 'pipeline-stage', stage), element('span', 'number', t('parallelQuestionCount', { count: number.format(job.count) })));
    row.append(details);
    return row;
  }));
}

function renderPlan() {
  const topics = (state?.topics ?? []).filter(topic => selectedTopics.has(topic.id));
  const estimate = Math.max(0, Number(perTopic.value) || 0);
  const total = topics.reduce((count, topic) => count + (topic.targetPlanned ? topic.target : estimate), 0);
  plan.textContent = t(topics.every(topic => topic.targetPlanned) ? 'plan' : 'estimatePlan', {
    topics: number.format(selectedTopics.size),
    questions: number.format(total),
  });
  const weights = state?.config.difficultyWeights;
  difficultyMix.hidden = !weights;
  if (weights) difficultyMix.textContent = t('difficultyMix', {
    easy: Math.round(weights.easy * 100),
    medium: Math.round(weights.medium * 100),
    hard: Math.round(weights.hard * 100),
  });
}

function renderEvents() {
  const list = state?.events ?? [];
  eventCount.textContent = t('eventCount', { count: number.format(list.length) });
  const previousSignature = signatures.events;
  replaceWhenChanged('events', events, list, () => {
    if (!list.length) {
      const empty = element('div', 'empty');
      empty.append(element('strong', '', t('startHint')), element('p', '', t('activityHint')));
      return [empty];
    }
    return list.map(event => {
      const row = element('div', 'event');
      row.dataset.level = event.level;
      const date = new Date(event.time);
      const timestamp = element('time', 'event-time', Number.isNaN(date.getTime()) ? '' : time.format(date));
      if (!Number.isNaN(date.getTime())) timestamp.dateTime = date.toISOString();
      row.append(element('span', 'event-marker'), element('p', 'event-message', event.message), timestamp);
      return row;
    });
  });
  if (follow.checked && previousSignature !== signatures.events && list.length) {
    workspaceBody.scrollTop = workspaceBody.scrollHeight;
    events.scrollTop = events.scrollHeight;
  }
}

function moveQuestion(change) {
  questionIndex += change;
  currentQuestionId = null;
  renderQuestion();
}

function renderMath(target) {
  if (typeof window.renderMathInElement !== 'function') return;
  window.renderMathInElement(target, {
    delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false }],
    throwOnError: false,
    trust: false,
    strict: 'ignore',
  });
}

function referenceSources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap(source => {
    if (!source || typeof source.url !== 'string') return [];
    let url;
    try {
      url = new URL(source.url);
    } catch {
      return [];
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
    seen.add(url.href);
    return [{ url: url.href, title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : url.hostname }];
  });
}

function renderQuestion() {
  for (const language of languageButtons) language.button.setAttribute('aria-pressed', String(language.code === questionLanguage));
  const questions = visibleQuestions();
  const savedIndex = questions.findIndex(question => question.id === currentQuestionId);
  if (savedIndex >= 0) questionIndex = savedIndex;
  questionIndex = Math.max(0, Math.min(questionIndex, questions.length - 1));
  const question = questions[questionIndex];
  currentQuestionId = question?.id ?? null;
  questionCount.textContent = t('publishedCount', { count: number.format(state?.totals.published ?? 0) });
  questionCount.title = t('questionCountDetails', {
    total: number.format(state?.questions.length ?? 0),
    rejected: number.format(state?.totals.rejected ?? 0),
  });
  for (const option of filter.options) {
    const count = option.value === 'all' ? state?.questions.length ?? 0
      : (state?.questions ?? []).filter(question => option.value === 'published'
        ? question.status === 'published'
        : option.value === 'validated' ? publishable(question) : question.validation?.passed === false).length;
    option.textContent = t('questionFilterCount', { label: t(option.value), count: number.format(count) });
  }
  position.textContent = questions.length ? t('position', { current: questionIndex + 1, total: questions.length }) : '—';
  previous.disabled = questionIndex === 0;
  next.disabled = questionIndex >= questions.length - 1;
  questionCheckbox.disabled = !question || !publishable(question) || pending;
  questionCheckbox.checked = Boolean(question && selectedQuestions.has(question.id));
  replaceWhenChanged('question', reviewBody, [question, questionLanguage, questionFilter], () => {
    if (!question) return [element('p', 'empty', t(questionFilter === 'all' ? 'questionHint' : 'noFilteredQuestions'))];
    const content = element('article');
    content.lang = questionLanguage;
    const meta = element('div', 'question-meta');
    const isValid = question.validation?.passed === true;
    meta.append(element('span', `badge ${isValid ? 'valid' : 'invalid'}`, t(question.status === 'published' ? 'published' : isValid ? 'valid' : 'invalid')));
    if (question.difficulty) meta.append(element('span', '', `${t('difficulty')}: ${t(question.difficulty)}`));
    content.append(meta);
    const topic = state.topics.find(item => item.id === question.topic);
    content.append(element('p', 'question-topic', topic ? displayTopicName(topic) : question.topic));
    const provenance = element('p', 'model-line', t('modelPair', {
      generation: question.generation?.model || t('unavailable'),
      review: question.generation?.reviewModel || t('unavailable'),
    }));
    provenance.lang = 'ru';
    content.append(provenance);
    const translation = question.translations?.[questionLanguage];
    if (translation) {
      const imageUrl = cloudTransport ? translation.imageUrl : translation.localImageUrl ?? translation.imageUrl;
      if (!safeImageUrl(imageUrl) || translation.imageContainsStatement === false) {
        content.append(element('p', 'question-text', safeImageUrl(imageUrl) ? translation.displayText ?? translation.text : translation.text));
      }
      if (safeImageUrl(imageUrl)) {
        const image = element('img', 'question-image');
        image.src = imageUrl;
        image.alt = question.diagram?.caption?.[questionLanguage] ?? translation.imageAlt ?? t('question');
        image.loading = 'lazy';
        content.append(image);
      }
      const options = element('ol', 'options');
      for (const [index, value] of (translation.options ?? []).entries()) {
        const isCorrect = index === question.correctOption;
        const item = element('li', `option${isCorrect ? ' correct' : ''}`);
        item.append(element('span', 'option-key', String.fromCharCode(65 + index)), element('span', 'option-text', value));
        if (isCorrect) item.append(element('span', 'sr-only', t('correct')));
        options.append(item);
      }
      content.append(options);
      for (const key of ['explanation', 'hint']) {
        if (!translation[key]) continue;
        const section = element('section', 'answer-section');
        section.append(element('h3', '', t(key)), element('p', '', translation[key]));
        content.append(section);
      }
    } else content.append(element('p', 'empty', t('missingTranslation')));
    const sources = referenceSources(question.generation?.referenceSources);
    if (sources.length) {
      const section = element('section', 'answer-section question-sources');
      section.lang = 'ru';
      const list = element('ul');
      for (const source of sources) {
        const item = element('li');
        const link = element('a', 'source-link', source.title);
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.append(element('span', 'sr-only', ` (${t('opensNewTab')})`));
        item.append(link);
        list.append(item);
      }
      section.append(element('h3', '', t('sources')), list);
      content.append(section);
    }
    if (question.validation?.issues?.length) {
      const section = element('section', 'answer-section');
      const issues = element('ul');
      for (const issue of question.validation.issues) issues.append(element('li', '', issue));
      section.append(element('h3', '', t('validation')), issues);
      content.append(section);
    }
    if (question.repair) {
      const section = element('section', 'answer-section');
      section.lang = 'ru';
      section.append(element('h3', '', t('repair')),
        element('p', '', t(`repair_${question.repair.status}`)),
        element('p', '', t('repairAttempt', { count: question.repair.attempts })));
      if (question.repair.history?.length) {
        const history = element('details');
        history.append(element('summary', '', t('repairHistory')));
        for (const entry of question.repair.history) {
          history.append(element('h3', '', t(entry.attempt === 0 ? 'repairOriginal' : 'repairRound', { count: entry.attempt })));
          const issues = element('ul');
          for (const issue of entry.issues ?? []) issues.append(element('li', '', issue));
          history.append(issues.childElementCount ? issues : element('p', '', t('repairPassed')));
        }
        section.append(history);
      }
      content.append(section);
    }
    renderMath(content);
    return [content];
  });
  renderControls();
}

function renderControls() {
  const active = state?.status === 'running';
  const resumable = ['paused', 'error'].includes(state?.status);
  run.hidden = active || resumable;
  pause.hidden = !active;
  resume.hidden = !resumable;
  for (const node of [run, pause, resume, publish, selectValid]) node.disabled = pending || !online;
  run.disabled ||= !selectedTopics.size;
  publish.disabled ||= !selectedQuestions.size;
  autoPublishNote.hidden = state?.autoPublish !== true;
  publish.textContent = selectedQuestions.size ? t('publishCount', { count: selectedQuestions.size }) : t('publish');
  perTopic.disabled = batchSize.disabled = mode.disabled = active || pending;
  source.disabled = active || pending;
  run.textContent = t(pending ? 'working' : 'run');
  pause.textContent = t(pending ? 'working' : 'pause');
  resume.textContent = t(pending ? 'working' : 'resume');
  for (const checkbox of topicList.querySelectorAll('input')) {
    checkbox.disabled = active || pending || checkbox.closest('.disabled') !== null;
  }
  for (const control of topicActions.querySelectorAll('button')) control.disabled = active || pending;
  for (const control of sourceField.querySelectorAll('button')) control.disabled = active || pending;
}

function render() {
  if (!state) {
    renderTopics();
    renderEvents();
    renderQuestion();
    renderControls();
    return;
  }
  status.dataset.status = state.status;
  statusText.textContent = t(state.status);
  modelLine.textContent = `${t('modelPair', {
    generation: state.model || t('unavailable'),
    review: state.reviewModel || t('unavailable'),
  })}${state.phase ? ` · ${state.phase}` : ''}`;
  totals.replaceChildren(...['eligible', 'generated', 'published', 'rejected'].map(key => {
    const item = element('span');
    item.append(element('strong', 'number', number.format(state.totals[key] ?? 0)), document.createTextNode(t(key)));
    return item;
  }));
  for (const [key, value] of [['repairQueued', state.repairTotals?.queued], ['repairCompleted', state.repairTotals?.completed]]) {
    if (!value) continue;
    const item = element('span');
    item.append(element('strong', 'number', number.format(value)), document.createTextNode(t(key)));
    totals.append(item);
  }
  budgetValue.textContent = money.format(state.budget.limit);
  budgetSpent.replaceChildren(element('span', '', t('spent')), element('span', 'number', money.format(state.budget.spent)));
  budgetReserved.replaceChildren(element('span', '', t('reserved')), element('span', 'number', money.format(state.budget.reserved)));
  const hasForecast = Number.isFinite(state.forecast?.costPerAccepted) && Number.isFinite(state.forecast?.estimatedTotal);
  forecast.hidden = false;
  if (hasForecast) {
    const cost = element('div', 'budget-line');
    cost.append(element('span', '', t('costPerAccepted')), element('span', 'number', money.format(state.forecast.costPerAccepted)));
    const estimate = element('div', 'budget-line');
    estimate.append(element('span', '', t('estimatedTotal')), element('span', 'number', money.format(state.forecast.estimatedTotal)));
    forecast.replaceChildren(element('p', 'forecast-note', t('forecastTarget', { count: number.format(state.forecast.target) })), cost, estimate,
      element('p', 'forecast-note', t('forecastNote', { count: number.format(state.forecast.sampleAccepted) })));
  } else {
    forecast.replaceChildren(element('p', 'forecast-note', t(state.forecast?.unavailableReason === 'accounting' ? 'forecastAccounting' : 'forecastPending')));
  }
  const limit = state.budget.limit || 1;
  const spentPercent = Math.min(100, Math.max(0, state.budget.spent / limit * 100));
  budgetUsed.style.width = `${spentPercent}%`;
  budgetHeld.style.width = `${Math.min(100 - spentPercent, Math.max(0, state.budget.reserved / limit * 100))}%`;
  for (const id of selectedQuestions) {
    if (!state.questions.some(question => question.id === id && publishable(question))) selectedQuestions.delete(id);
  }
  renderTopics();
  renderPipeline();
  renderPlan();
  renderEvents();
  renderQuestion();
}

function safeImageUrl(value) {
  if (typeof value !== 'string') return false;
  if (!cloudTransport && /^\/media\/[^?#]+$/.test(value) && !value.includes('..')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && Array.isArray(state?.mediaOrigins) && state.mediaOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

function notifyError(message) {
  errorNotice.textContent = message;
  errorNotice.hidden = !message;
}

async function request(path, options = {}) {
  if (cloudTransport) {
    const body = options.body === undefined ? null : JSON.parse(options.body);
    return new Promise((resolve, reject) => {
      globalThis.google.script.run
        .withSuccessHandler(value => {
          if (!value || typeof value !== 'object') { reject(new Error(t('invalidResponse'))); return; }
          if (value.error) { reject(new Error(value.error)); return; }
          resolve(value);
        })
        .withFailureHandler(error => reject(new Error(error?.message || t('requestFailed'))))
        .studioRequest(path, body);
    });
  }
  const controller = new AbortController();
  controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || (response.status === 403 ? t('unauthorized') : `${t('requestFailed')} (${response.status})`));
    if (!body || typeof body !== 'object') throw new Error(t('invalidResponse'));
    return body;
  } finally {
    clearTimeout(timeout);
    controllers.delete(controller);
  }
}

function validState(value) {
  return value && Array.isArray(value.topics) && Array.isArray(value.events) && Array.isArray(value.questions)
    && value.config && value.totals && value.budget
    && ['limit', 'spent', 'reserved'].every(key => Number.isFinite(value.budget[key]));
}

async function refreshState() {
  const value = await request('/api/state');
  if (!validState(value)) throw new Error(t('invalidResponse'));
  const previousError = state?.error || state?.cloudError;
  state = value;
  if (!initialized) {
    const savedTopics = Array.isArray(state.selectedTopicIds) && state.selectedTopicIds.length ? new Set(state.selectedTopicIds) : null;
    for (const topic of state.topics) if (topic.eligible && (!savedTopics || savedTopics.has(topic.id))) selectedTopics.add(topic.id);
    perTopic.value = String(state.config.perTopic);
    batchSize.value = String(state.config.batchSize);
    if (['generate', 'parse'].includes(state.mode)) mode.value = state.mode;
    if (typeof state.sourceText === 'string') source.value = state.sourceText;
    sourceField.hidden = mode.value !== 'parse';
    initialized = true;
  }
  if ((failures > 0 || previousError && previousError === errorNotice.textContent) && !state.error && !state.cloudError) notifyError('');
  online = true;
  connection.classList.remove('offline');
  connection.textContent = t('connected');
  render();
}

async function action(path, body = {}) {
  if (pending) return;
  pending = true;
  notifyError('');
  renderControls();
  try {
    if (!cloudTransport && !csrfToken) {
      const session = await request('/api/session');
      if (typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error(t('unauthorized'));
      csrfToken = session.csrfToken;
    }
    const requests = cloudTransport && ['/api/publish', '/api/rerender'].includes(path) && Array.isArray(body.ids)
      ? [...new Set(body.ids)].map(id => ({ ...body, ids: [id] })) : [body];
    for (const payload of requests) {
      await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-Studio-Token': csrfToken } : {}) },
        body: JSON.stringify(payload),
      });
    }
    await refreshState();
    if (state.error || state.cloudError) notifyError(state.error || state.cloudError);
  } catch (error) {
    notifyError(error instanceof Error ? error.message : t('requestFailed'));
  } finally {
    pending = false;
    renderControls();
  }
}

composer.addEventListener('submit', event => {
  event.preventDefault();
  if (!selectedTopics.size || pending || !online) return;
  const perTopicValue = Number(perTopic.value);
  const batchSizeValue = Number(batchSize.value);
  if (!Number.isSafeInteger(perTopicValue) || perTopicValue < 1 || !Number.isSafeInteger(batchSizeValue) || batchSizeValue < 1) {
    notifyError(t('formError'));
    return;
  }
  if (mode.value === 'parse' && !source.value.trim()) {
    notifyError(t('sourceError'));
    source.focus();
    return;
  }
  void action('/api/start', {
    perTopic: perTopicValue,
    batchSize: batchSizeValue,
    mode: mode.value,
    topicIds: [...selectedTopics],
    ...(mode.value === 'parse' ? { sourceText: source.value.trim() } : {}),
  });
});
perTopic.addEventListener('input', renderPlan);
mode.addEventListener('change', () => { sourceField.hidden = mode.value !== 'parse'; });
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    if (!file.name.toLowerCase().endsWith('.txt') || file.size > 2 * 1024 * 1024) throw new Error(t('fileError'));
    const content = await file.text();
    if (content.length > source.maxLength) throw new Error(t('fileError'));
    source.value = content;
  } catch (error) {
    notifyError(error instanceof Error ? error.message : t('fileError'));
  } finally {
    fileInput.value = '';
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') studio.classList.remove('topics-open');
});

async function poll() {
  clearTimeout(pollTimer);
  if (stopped) return;
  try {
    await refreshState();
    failures = 0;
    if (state.error || state.cloudError) notifyError(state.error || state.cloudError);
  } catch (error) {
    if (stopped) return;
    failures += 1;
    online = false;
    connection.classList.add('offline');
    const seconds = cloudTransport ? pollInterval / 1000 : Math.min(30, 2 ** failures);
    connection.textContent = t('reconnect', { seconds });
    notifyError(error instanceof Error ? error.message : t('requestFailed'));
    renderControls();
  } finally {
    if (!stopped) pollTimer = setTimeout(() => void poll(), failures && !cloudTransport ? Math.min(30000, 1000 * 2 ** failures) : pollInterval);
  }
}

window.addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(pollTimer);
  for (const controller of controllers) controller.abort();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    stopped = false;
    void poll();
  }
});
render();
void poll();
