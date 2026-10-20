import { db, ref, get, set, update, remove, push } from '../lib/firebase';

const forbiddenDatabaseKeyCharacters = new Set(['.', '#', '$', '[', ']', '/']);
const allowedStatuses = new Set(['draft', 'published']);
const allowedDifficulties = new Set(['easy', 'medium', 'hard']);
export const questionLanguages = Object.freeze([
  { code: 'kk', label: 'Қазақша' },
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
]);

export function questionContent(question = {}) {
  return {
    text: question.text || '',
    options: question.options ? [...question.options] : ['', '', '', ''],
    explanation: question.explanation || '',
    hint: question.hint || '',
    imageUrl: question.imageUrl || '',
  };
}

function validDatabaseKey(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && [...value].every(character =>
      !forbiddenDatabaseKeyCharacters.has(character)
      && character.charCodeAt(0) >= 32
      && character.charCodeAt(0) !== 127);
}

export function validateQuestion(questionData) {
  if (!questionData || typeof questionData !== 'object' || Array.isArray(questionData)) {
    throw new Error('Question data is required.');
  }

  let translations;
  if (questionData.translations !== undefined) {
    if (!questionData.translations || typeof questionData.translations !== 'object'
      || Array.isArray(questionData.translations) || !questionData.translations.kk) {
      throw new Error('Translations must include a Kazakh version.');
    }
    translations = {};
    for (const [language, content] of Object.entries(questionData.translations)) {
      if (!questionLanguages.some(item => item.code === language)
        || !content || typeof content !== 'object' || Array.isArray(content)) {
        throw new Error('Invalid question translation.');
      }
      try {
        translations[language] = questionContent(validateQuestion({
          ...questionData,
          text: content.text,
          options: content.options,
          explanation: content.explanation,
          hint: content.hint,
          imageUrl: content.imageUrl,
          translations: undefined,
        }));
      } catch (error) {
        throw new Error(`${language.toUpperCase()}: ${error.message}`, { cause: error });
      }
    }
    questionData = { ...questionData, ...translations.kk };
  }

  const text = typeof questionData.text === 'string' ? questionData.text.trim() : '';
  const imageUrl = typeof questionData.imageUrl === 'string' ? questionData.imageUrl.trim() : '';
  if (!text && !imageUrl) {
    throw new Error('Enter question text or add an image.');
  }
  if (text.length > 3500) {
    throw new Error('Question text is too long for Telegram.');
  }
  if (imageUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      throw new Error('Question image must have a valid HTTPS URL.');
    }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      throw new Error('Question image must have a valid HTTPS URL.');
    }
    if (imageUrl.length > 2048) {
      throw new Error('Question image URL is too long.');
    }
  }

  if (!Array.isArray(questionData.options) || questionData.options.length !== 4
    || !questionData.options.every(option => typeof option === 'string' && option.trim() && option.length <= 500)) {
    throw new Error('Enter exactly four nonempty answer options.');
  }
  if (!Number.isInteger(questionData.correctOption)
    || questionData.correctOption < 0 || questionData.correctOption >= questionData.options.length) {
    throw new Error('Select a valid correct answer.');
  }
  if (!validDatabaseKey(questionData.topic)) {
    throw new Error('Select a valid topic.');
  }
  if (!allowedStatuses.has(questionData.status)) {
    throw new Error('Select a valid question status.');
  }
  if (!allowedDifficulties.has(questionData.difficulty)) {
    throw new Error('Select a valid difficulty.');
  }
  const explanation = questionData.explanation ?? '';
  const hint = questionData.hint ?? '';
  if (typeof explanation !== 'string' || typeof hint !== 'string') {
    throw new Error('Explanation and hint must be text.');
  }
  if (explanation.length > 3500 || hint.length > 3500) {
    throw new Error('Explanation or hint is too long for Telegram.');
  }

  return {
    text,
    imageUrl,
    options: questionData.options.map(option => option.trim()),
    correctOption: questionData.correctOption,
    topic: questionData.topic,
    status: questionData.status,
    difficulty: questionData.difficulty,
    explanation: explanation.trim(),
    hint: hint.trim(),
    ...(translations ? { translations } : {}),
  };
}

async function validateTopic(topicId) {
  const topicSnapshot = await get(ref(db, `topics/${topicId}`));
  if (!topicSnapshot.exists() || topicSnapshot.val()?.isLast !== true) {
    throw new Error('Select an existing leaf topic.');
  }
}

export async function getQuestions() {
  const snapshot = await get(ref(db, 'questions'));
  if (!snapshot.exists()) {
    return [];
  }
  return Object.entries(snapshot.val()).map(([id, question]) => ({ id, ...question }));
}

export async function getTopics() {
  const snapshot = await get(ref(db, 'topics'));
  if (!snapshot.exists()) {
    return [];
  }
  return Object.entries(snapshot.val()).map(([id, topic]) => ({ id, ...topic }));
}

export async function createQuestion(questionData) {
  const question = validateQuestion(questionData);
  await validateTopic(question.topic);
  const questionRef = push(ref(db, 'questions'));
  if (!questionRef.key) {
    throw new Error('Could not allocate a question ID.');
  }
  const now = Date.now();
  await set(questionRef, {
    ...question,
    createdAt: now,
    updatedAt: now,
    statistics: {
      attemptCount: 0,
      correctCount: 0,
      wrongCount: 0,
      hintUsage: 0,
      averageResponseTime: 0,
      difficultyPerception: 0,
    },
  });
  return questionRef.key;
}

export async function updateQuestion(questionId, questionData) {
  if (!validDatabaseKey(questionId)) {
    throw new Error('Invalid question ID.');
  }
  const question = validateQuestion(questionData);
  await validateTopic(question.topic);
  const questionRef = ref(db, `questions/${questionId}`);
  if (!(await get(questionRef)).exists()) {
    throw new Error('Question no longer exists.');
  }
  await update(questionRef, { ...question, updatedAt: Date.now() });
}

export async function deleteQuestion(questionId) {
  if (!validDatabaseKey(questionId)) {
    throw new Error('Invalid question ID.');
  }
  await remove(ref(db, `questions/${questionId}`));
}
