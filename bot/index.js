const { Bot, InlineKeyboard } = require('grammy');
const { randomUUID } = require('node:crypto');
const { db, transactionLoaded, transactionExisting } = require('./firebase');
const { t, normalizeLanguage } = require('./i18n');
const { localizeQuestion } = require('./questionI18n');
const { generateBrowserOtp, digestBrowserOtp } = require('./browserAuthOtp');
const { assertId, getQuestion, listQuestions, shuffle, topicOf, findSimilar, formatQuestion, splitMessage } = require('./quizData');

function userId(ctx) {
  const id = ctx.from?.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid Telegram user');
  return id;
}

async function languageFor(ctx) {
  const snapshot = await db.ref(`users/${userId(ctx)}/language`).once('value');
  return normalizeLanguage(snapshot.val() || ctx.from.language_code);
}

async function saveUser(ctx) {
  const id = userId(ctx);
  const ref = db.ref(`users/${id}`);
  const now = Date.now();
  const result = await transactionLoaded(ref, (current) => ({
    ...(current || {}),
    telegramId: id,
    firstName: ctx.from.first_name || '',
    lastName: ctx.from.last_name || '',
    username: ctx.from.username || '',
    language: normalizeLanguage(current?.language || ctx.from.language_code),
    createdAt: current?.createdAt || now,
    lastActiveAt: now
  }));
  return result.snapshot.val();
}

async function showBrowserAuthRequest(ctx, requestId) {
  const id = userId(ctx);
  const language = await languageFor(ctx);
  const admin = await db.ref(`admins/${id}`).once('value');
  if (!admin.exists()) return ctx.reply(t(language, 'adminOnly'));
  const now = Date.now();
  const otp = generateBrowserOtp();
  const result = await transactionExisting(db.ref(`browserAuthRequests/${requestId}`), (current) => {
    if (!current || current.status !== 'pending' || !Number.isSafeInteger(current.expiresAt)
      || current.expiresAt <= now || !/^[a-f0-9]{64}$/.test(current.challenge || '')) {
      return;
    }
    return {
      ...current,
      status: 'otp_issued',
      issuedTo: id,
      issuedAt: now,
      attempts: 0,
      otpHash: digestBrowserOtp(requestId, current.challenge, otp),
    };
  });
  if (!result.committed) {
    return ctx.reply(t(language, 'browserLoginExpired'));
  }
  await ctx.reply(t(language, 'browserLoginCode', otp));
}

function menu(language) {
  return new InlineKeyboard()
    .text(t(language, 'menuRandom'), 'menu:random').row()
    .text(t(language, 'menuTopics'), 'menu:topics').row()
    .text(t(language, 'menuStats'), 'menu:stats').row()
    .text(t(language, 'menuLanguage'), 'menu:language');
}

async function showMenu(ctx) {
  const language = await languageFor(ctx);
  await ctx.reply(t(language, 'welcome'), { reply_markup: menu(language) });
}

async function showLanguages(ctx) {
  const language = await languageFor(ctx);
  await ctx.reply(t(language, 'chooseLanguage'), { reply_markup: new InlineKeyboard()
    .text(t(language, 'languageKk'), 'lang:kk').row()
    .text(t(language, 'languageRu'), 'lang:ru').row()
    .text(t(language, 'languageEn'), 'lang:en') });
}

async function showTopics(ctx, parentId = '', page = 0) {
  const language = await languageFor(ctx);
  const snapshot = await db.ref('topics').once('value');
  const topics = [];
  snapshot.forEach((child) => {
    if (/^[A-Za-z0-9_-]{1,50}$/.test(child.key) && child.val()?.isActive !== false) {
      topics.push({ id: child.key, ...child.val() });
    }
  });
  if (!topics.length) return ctx.reply(t(language, 'noTopics'));
  const currentParent = parentId ? topics.find((topic) => topic.id === parentId) : null;
  if (parentId && !currentParent) return ctx.reply(t(language, 'invalid'));
  const children = topics.filter((topic) => String(topic.parentId || '') === parentId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!children.length) return ctx.reply(t(language, 'noTopics'));
  const pageSize = 12;
  const pages = Math.ceil(children.length / pageSize);
  const selectedPage = Math.min(Math.max(page, 0), pages - 1);
  const keyboard = new InlineKeyboard();
  for (const topic of children.slice(selectedPage * pageSize, (selectedPage + 1) * pageSize)) {
    const name = topic[`name${language[0].toUpperCase()}${language.slice(1)}`] || topic.name || topic.nameKk;
    if (typeof name === 'string' && name.trim()) keyboard.text(name.slice(0, 60), `topic:${topic.id}`).row();
  }
  if (selectedPage > 0) keyboard.text(t(language, 'previousPage'), `tl:${parentId || 'root'}:${selectedPage - 1}`);
  if (selectedPage + 1 < pages) keyboard.text(t(language, 'nextPage'), `tl:${parentId || 'root'}:${selectedPage + 1}`);
  if (parentId) keyboard.row().text(t(language, 'back'), `tl:${currentParent.parentId || 'root'}:0`);
  await ctx.reply(t(language, 'chooseTopic'), { reply_markup: keyboard });
}

async function showStats(ctx) {
  const id = userId(ctx);
  const language = await languageFor(ctx);
  const [channelSnapshot, practiceSnapshot] = await Promise.all([
    db.ref('channelQuizAttempts').orderByChild('userId').equalTo(id).once('value'),
    db.ref(`practiceAttempts/${id}`).once('value')
  ]);
  let total = 0;
  let correct = 0;
  practiceSnapshot.forEach((child) => {
    total += 1;
    correct += Number(child.val().isCorrect === true);
  });
  channelSnapshot.forEach((child) => {
    const answers = Object.values(child.val().answers || {});
    total += answers.length;
    correct += answers.filter((answer) => answer.isCorrect).length;
  });
  await ctx.reply(t(language, 'stats', correct, total));
}

function questionKeyboard(question) {
  const keyboard = new InlineKeyboard();
  question.options.forEach((option, index) => {
    keyboard.text(String.fromCharCode(65 + index), `p:${question.id}:${index}`).row();
  });
  return keyboard;
}

async function sendPracticeQuestion(ctx, session) {
  const language = await languageFor(ctx);
  const question = localizeQuestion(await getQuestion(session.currentQuestionId), language);
  if (!question) return ctx.reply(t(language, 'invalid'));
  const header = t(language, 'question', session.index + 1);
  const body = formatQuestion(header, question);
  if (question.imageUrl && body.length <= 1024) {
    await ctx.replyWithPhoto(question.imageUrl, { caption: body, reply_markup: questionKeyboard(question) });
  } else {
    if (question.imageUrl) await ctx.replyWithPhoto(question.imageUrl, { caption: header });
    const chunks = splitMessage(body);
    for (const [index, chunk] of chunks.entries()) {
      await ctx.reply(chunk, index === chunks.length - 1 ? { reply_markup: questionKeyboard(question) } : {});
    }
  }
}

async function startPractice(ctx, mode, topicId, publicationId) {
  const id = userId(ctx);
  const language = await languageFor(ctx);
  const [available, activeSnapshot] = await Promise.all([
    listQuestions(),
    db.ref('publications').orderByChild('status').equalTo('active').once('value')
  ]);
  const activeQuestionIds = new Set();
  activeSnapshot.forEach((publication) => {
    for (const questionId of publication.val().questions || []) activeQuestionIds.add(questionId);
  });
  const questions = available.filter((question) => !activeQuestionIds.has(question.id));
  let selected;
  if (mode === 'similar') {
    const attempt = await getChannelAttempt(publicationId, id);
    const publication = await getCompletedPublication(publicationId);
    if (!publication) return ctx.reply(t(language, 'closed'));
    const mistakeIds = publication.questions.filter((questionId) => !attempt?.answers?.[questionId]?.isCorrect);
    if (!mistakeIds.length) return ctx.reply(t(language, 'noMistakes'));
    const sources = mistakeIds.map((questionId) => publicationQuestion(publication, questionId)).filter(Boolean);
    selected = [];
    for (const source of sources) {
      const match = findSimilar(questions, [source], [...publication.questions, ...selected.map((item) => item.id)], 1)[0];
      if (match) selected.push(match);
    }
    if (!selected.length) return ctx.reply(t(language, 'noSimilar'));
  } else {
    const pool = mode === 'topic' ? questions.filter((question) => topicOf(question) === topicId) : questions;
    selected = shuffle(pool);
    if (!selected.length) return ctx.reply(t(language, 'noQuestions'));
  }
  const session = {
    sessionId: randomUUID(), mode, topicId: topicId || null, publicationId: publicationId || null,
    questionIds: selected.map((question) => question.id), currentQuestionId: selected[0].id,
    index: 0, answers: {}, startedAt: Date.now(), updatedAt: Date.now()
  };
  await db.ref(`practiceSessions/${id}`).set(session);
  await sendPracticeQuestion(ctx, session);
}

async function answerPractice(ctx, questionId, selectedOption) {
  const id = userId(ctx);
  const language = await languageFor(ctx);
  const question = localizeQuestion(await getQuestion(questionId), language);
  if (!question || selectedOption >= question.options.length) {
    return ctx.answerCallbackQuery({ text: t(language, 'invalid'), show_alert: true });
  }
  const ref = db.ref(`practiceSessions/${id}`);
  const correct = selectedOption === question.correctOption;
  const result = await transactionExisting(ref, (current) => {
    if (!current || current.currentQuestionId !== questionId || current.answers?.[questionId]) return;
    return { ...current, answers: { ...current.answers, [questionId]: {
      selectedOption, isCorrect: correct, answeredAt: Date.now()
    } }, updatedAt: Date.now() };
  });
  const session = result.snapshot.val();
  if (session?.answers?.[questionId]) {
    const answer = session.answers[questionId];
    await transactionLoaded(db.ref(`practiceAttempts/${id}/${session.sessionId}_${questionId}`),
      (current) => current || { ...answer, questionId, sessionId: session.sessionId,
        mode: session.mode, topicId: session.topicId || null, publicationId: session.publicationId || null });
  }
  if (!result.committed) return ctx.answerCallbackQuery({ text: t(language, 'alreadyAnswered'), show_alert: true });
  const feedback = `${t(language, correct ? 'correct' : 'wrong')}${question.explanation ? `\n\n${question.explanation}` : ''}`;
  await ctx.answerCallbackQuery({ text: t(language, correct ? 'correct' : 'wrong'), show_alert: true });
  await ctx.reply(feedback.slice(0, 4096), { reply_markup: new InlineKeyboard().text(t(language, 'next'), 'practice:next') });
}

async function nextPractice(ctx) {
  const id = userId(ctx);
  const language = await languageFor(ctx);
  const ref = db.ref(`practiceSessions/${id}`);
  const result = await transactionExisting(ref, (current) => {
    if (!current || !current.answers?.[current.currentQuestionId]) return;
    const index = current.index + 1;
    if (index >= current.questionIds.length) return { ...current, currentQuestionId: null, status: 'completed', updatedAt: Date.now() };
    return { ...current, index, currentQuestionId: current.questionIds[index], updatedAt: Date.now() };
  });
  if (!result.committed) return ctx.reply(t(language, 'invalid'));
  const session = result.snapshot.val();
  if (session.status === 'completed') {
    const answers = Object.values(session.answers || {});
    await ctx.reply(`${t(language, 'finished')} ${t(language, 'result', answers.filter((answer) => answer.isCorrect).length, answers.length)}`,
      { reply_markup: menu(language) });
  } else {
    await sendPracticeQuestion(ctx, session);
  }
}

async function getCompletedPublication(publicationId) {
  const snapshot = await db.ref(`publications/${assertId(publicationId)}`).once('value');
  const publication = snapshot.val();
  return publication?.status === 'completed' ? publication : null;
}

async function getChannelAttempt(publicationId, id) {
  const snapshot = await db.ref(`channelQuizAttempts/${assertId(publicationId)}_${id}`).once('value');
  return snapshot.val();
}

function publicationQuestion(publication, questionId) {
  const value = publication.questionData?.[questionId];
  return localizeQuestion(value, 'kk') && Number.isInteger(value.correctOption)
    ? { id: questionId, ...value } : null;
}

async function showReview(ctx, publicationId) {
  const id = userId(ctx);
  const language = await languageFor(ctx);
  const publication = await getCompletedPublication(publicationId);
  if (!publication) return ctx.reply(t(language, 'closed'));
  const attempt = await getChannelAttempt(publicationId, id);
  const answers = attempt?.answers || {};
  const correct = Object.values(answers).filter((answer) => answer.isCorrect).length;
  const mistakes = publication.questions.filter((questionId) => !answers[questionId]?.isCorrect);
  const header = t(language, 'reviewTitle', correct, publication.questionCount);
  if (!mistakes.length) return ctx.reply(`${header}\n\n${t(language, 'noMistakes')}`);
  await ctx.reply(`${header}\n\n${t(language, 'reviewOffer', mistakes.length)}`, {
    reply_markup: new InlineKeyboard().text(t(language, 'review'), `review:${publicationId}:0`).row()
      .text(t(language, 'similar'), `similar:${publicationId}`)
  });
}

async function showMistake(ctx, publicationId, index) {
  const id = userId(ctx);
  const language = await languageFor(ctx);
  const publication = await getCompletedPublication(publicationId);
  if (!publication) return ctx.reply(t(language, 'closed'));
  const attempt = await getChannelAttempt(publicationId, id);
  const mistakes = publication.questions.filter((questionId) => !attempt?.answers?.[questionId]?.isCorrect);
  if (index >= mistakes.length) return ctx.reply(t(language, 'invalid'));
  const questionId = mistakes[index];
  const answer = attempt?.answers?.[questionId];
  const question = localizeQuestion(publicationQuestion(publication, questionId), language);
  if (!question) return ctx.reply(t(language, 'invalid'));
  const keyboard = new InlineKeyboard();
  if (index + 1 < mistakes.length) keyboard.text(t(language, 'next'), `review:${publicationId}:${index + 1}`).row();
  keyboard.text(t(language, 'similar'), `similar:${publicationId}`);
  if (question.imageUrl) await ctx.replyWithPhoto(question.imageUrl);
  const review = t(language, 'reviewQuestion', question.imageUrl ? '' : question.text,
    answer ? question.options[answer.selectedOption] : t(language, 'notAnswered'),
    question.options[question.correctOption], question.explanation);
  const chunks = splitMessage(review);
  for (const [chunkIndex, chunk] of chunks.entries()) {
    await ctx.reply(chunk, chunkIndex === chunks.length - 1 ? { reply_markup: keyboard } : {});
  }
}

async function answerChannel(ctx, publicationId, questionIndex, selectedOption) {
  const id = userId(ctx);
  const language = await languageFor(ctx);
  const snapshot = await db.ref(`publications/${publicationId}`).once('value');
  const publication = snapshot.val();
  const now = Date.now();
  const post = publication?.questionPosts?.[questionIndex];
  if (!publication || publication.status !== 'active' || !post
    || String(ctx.callbackQuery.message?.chat?.id) !== String(post.chatId)
    || ctx.callbackQuery.message?.message_id !== post.messageId
    || now > post.closesAt) {
    return ctx.answerCallbackQuery({ text: t(language, 'closed'), show_alert: true });
  }
  const questionId = publication.questions[questionIndex];
  const question = localizeQuestion(publicationQuestion(publication, questionId), language);
  if (!question || selectedOption >= question.options.length) {
    return ctx.answerCallbackQuery({ text: t(language, 'invalid'), show_alert: true });
  }
  const correct = selectedOption === question.correctOption;
  const ref = db.ref(`channelQuizAttempts/${publicationId}_${id}`);
  const result = await transactionLoaded(ref, (current) => {
    if (current?.answers?.[questionId]) return;
    return {
      ...(current || {}), userId: id, publicationId,
      createdAt: current?.createdAt || now,
      answers: { ...(current?.answers || {}), [questionId]: { selectedOption, isCorrect: correct, answeredAt: now } },
      updatedAt: now
    };
  });
  await ctx.answerCallbackQuery({ text: t(language, result.committed ? (correct ? 'correct' : 'wrong') : 'alreadyAnswered'), show_alert: true });
}

function createBot() {
  if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is required');
  const bot = new Bot(process.env.BOT_TOKEN);
  bot.use(async (ctx, next) => {
    try {
      if (ctx.from?.id) {
        const snapshot = await db.ref(`users/${userId(ctx)}/isBlocked`).once('value');
        if (snapshot.val() === true) {
          if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(await languageFor(ctx), 'blocked'), show_alert: true });
          return;
        }
      }
      if (ctx.callbackQuery && !ctx.callbackQuery.data?.startsWith('c:') && ctx.chat?.type !== 'private') {
        await ctx.answerCallbackQuery({ text: t(await languageFor(ctx), 'invalid'), show_alert: true });
        return;
      }
      await next();
    } catch (error) {
      const language = ctx.from ? await languageFor(ctx).catch(() => 'kk') : 'kk';
      try {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(language, 'error'), show_alert: true });
        else if (ctx.chat?.type === 'private') await ctx.reply(t(language, 'error'));
      } catch (_) {
        throw error;
      }
      throw error;
    }
  });
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await saveUser(ctx);
    const payload = ctx.match?.trim() || '';
    const quizMatch = /^quiz_([a-f0-9]{24})$/.exec(payload);
    const browserAuthMatch = /^admin_([a-f0-9]{48})$/.exec(payload);
    if (quizMatch) await showReview(ctx, quizMatch[1]);
    else if (browserAuthMatch) await showBrowserAuthRequest(ctx, browserAuthMatch[1]);
    else await showMenu(ctx);
  });
  bot.command('help', async (ctx) => { if (ctx.chat.type === 'private') await ctx.reply(t(await languageFor(ctx), 'help')); });
  bot.command('language', async (ctx) => { if (ctx.chat.type === 'private') await showLanguages(ctx); });
  bot.command('random', async (ctx) => { if (ctx.chat.type === 'private') await startPractice(ctx, 'random'); });
  bot.command('topics', async (ctx) => { if (ctx.chat.type === 'private') await showTopics(ctx); });
  bot.command('stats', async (ctx) => { if (ctx.chat.type === 'private') await showStats(ctx); });
  bot.command('admin', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const language = await languageFor(ctx);
    const admin = await db.ref(`admins/${userId(ctx)}`).once('value');
    if (!admin.exists()) return ctx.reply(t(language, 'adminOnly'));
    const url = process.env.MINI_APP_URL;
    if (!url || new URL(url).protocol !== 'https:') throw new Error('MINI_APP_URL must use HTTPS');
    await ctx.reply(t(language, 'adminOpen'), { reply_markup: new InlineKeyboard().webApp(t(language, 'adminOpen'), url) });
  });
  bot.callbackQuery(/^c:([a-f0-9]{24}):(\d{1,4}):([0-7])$/, async (ctx) => {
    await answerChannel(ctx, ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3]));
  });
  bot.callbackQuery('menu:random', async (ctx) => { await ctx.answerCallbackQuery(); await startPractice(ctx, 'random'); });
  bot.callbackQuery('menu:topics', async (ctx) => { await ctx.answerCallbackQuery(); await showTopics(ctx); });
  bot.callbackQuery('menu:stats', async (ctx) => { await ctx.answerCallbackQuery(); await showStats(ctx); });
  bot.callbackQuery('menu:language', async (ctx) => { await ctx.answerCallbackQuery(); await showLanguages(ctx); });
  bot.callbackQuery(/^lang:(kk|ru|en)$/, async (ctx) => {
    await db.ref(`users/${userId(ctx)}/language`).set(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: t(ctx.match[1], 'languageSaved') });
    await showMenu(ctx);
  });
  bot.callbackQuery(/^topic:([A-Za-z0-9_-]{1,50})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const topicId = assertId(ctx.match[1]);
    const snapshot = await db.ref('topics').once('value');
    const selectedTopic = snapshot.child(topicId).val();
    if (!selectedTopic || selectedTopic.isActive === false) {
      return ctx.reply(t(await languageFor(ctx), 'noTopics'));
    }
    let hasChildren = false;
    snapshot.forEach((child) => {
      if (child.val()?.parentId === topicId && child.val()?.isActive !== false) hasChildren = true;
    });
    if (hasChildren) await showTopics(ctx, topicId);
    else await startPractice(ctx, 'topic', topicId);
  });
  bot.callbackQuery(/^tl:(root|[A-Za-z0-9_-]{1,50}):(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTopics(ctx, ctx.match[1] === 'root' ? '' : ctx.match[1], Number(ctx.match[2]));
  });
  bot.callbackQuery(/^p:([A-Za-z0-9_-]{1,80}):([0-7])$/, async (ctx) => {
    await answerPractice(ctx, assertId(ctx.match[1]), Number(ctx.match[2]));
  });
  bot.callbackQuery('practice:next', async (ctx) => { await ctx.answerCallbackQuery(); await nextPractice(ctx); });
  bot.callbackQuery(/^review:([a-f0-9]{24}):(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery(); await showMistake(ctx, ctx.match[1], Number(ctx.match[2]));
  });
  bot.callbackQuery(/^similar:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCallbackQuery(); await startPractice(ctx, 'similar', null, ctx.match[1]);
  });
  bot.catch((error) => { throw error.error; });
  return bot;
}

module.exports = { createBot };
