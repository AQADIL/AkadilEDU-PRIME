const { normalizeLanguage } = require('./i18n');

const questionLanguages = Object.freeze(['kk', 'ru', 'en']);

function validImageUrl(value) {
  if (!value) return value === undefined || value === '';
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validQuestionContent(content) {
  return Boolean(content && typeof content === 'object' && !Array.isArray(content)
    && typeof content.text === 'string' && content.text.length <= 3500
    && (content.text.trim() || content.imageUrl)
    && validImageUrl(content.imageUrl)
    && (content.imageContainsStatement === undefined || typeof content.imageContainsStatement === 'boolean')
    && (content.imageContainsStatement !== false || content.text.trim())
    && Array.isArray(content.options) && content.options.length === 4
    && content.options.every((option) => typeof option === 'string' && option.trim()
      && option.length <= 64 && !/[\r\n\u0085\u2028\u2029]/u.test(option))
    && ['explanation', 'hint'].every((field) => content[field] === undefined
      || (typeof content[field] === 'string' && content[field].length <= 3500)));
}

function localizeQuestion(question, language) {
  if (!question) return null;
  const requested = question.translations?.[normalizeLanguage(language)];
  const kazakh = question.translations?.kk;
  const content = [requested, kazakh, question].find(validQuestionContent);
  if (!content) return null;
  return {
    ...question,
    text: content.text,
    options: content.options,
    explanation: content.explanation || '',
    hint: content.hint || '',
    imageUrl: content.imageUrl || '',
    imageContainsStatement: content.imageContainsStatement !== false,
  };
}

module.exports = { questionLanguages, validQuestionContent, localizeQuestion };
