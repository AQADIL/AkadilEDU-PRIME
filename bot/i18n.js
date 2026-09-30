const translations = Object.freeze({
  kk: {
    welcome: 'Сәлем! Қажетті бөлімді таңдаңыз.',
    menuRandom: '🎯 Аралас есептер', menuTopics: '📚 Тақырыптар', menuStats: '📊 Нәтижелер', menuLanguage: '🌐 Тіл',
    help: 'Командалар: /random — аралас есептер, /topics — тақырыптар, /stats — нәтижелер, /language — тіл.',
    chooseLanguage: 'Тілді таңдаңыз:', languageSaved: 'Тіл сақталды.',
    chooseTopic: 'Тақырыпты таңдаңыз:', noTopics: 'Қолжетімді тақырыптар жоқ.', back: '← Артқа', previousPage: '← Алдыңғы', nextPage: 'Келесі →',
    noQuestions: 'Жарияланған жарамды сұрақтар жоқ.',
    question: (n) => `Сұрақ ${n}`, next: 'Келесі есеп →',
    correct: '✅ Дұрыс!', wrong: '❌ Қате!', alreadyAnswered: 'Сіз бұл сұраққа жауап бердіңіз.',
    closed: 'Бұл сұрақтың жауап беру уақыты аяқталды.', invalid: 'Сұрақ қолжетімсіз.',
    result: (correct, total) => `Нәтиже: ${correct}/${total}`,
    stats: (correct, total) => `📊 Жауаптар: ${total}\n✅ Дұрыс: ${correct}\n❌ Қате: ${total - correct}`,
    reviewTitle: (correct, total) => `Бүгінгі викторина: ${correct}/${total}.`,
    reviewOffer: (count) => `Сіз ${count} сұрақтан қателестіңіз. Ұқсас есептерді шығарып көресіз бе?`,
    noMistakes: 'Қате жоқ. Жарайсыз!', noSimilar: 'Осы тақырыптар бойынша басқа жарияланған есептер әзірше жоқ.',
    similar: 'Ұқсас есептер', review: 'Қатемен жұмыс', notAnswered: 'Жауап берілмеді', languageKk: 'Қазақша', languageRu: 'Русский', languageEn: 'English',
    reviewQuestion: (text, selected, right, explanation) => `❌ ${text}\n\nСіздің жауабыңыз: ${selected}\nДұрыс жауап: ${right}${explanation ? `\nТүсіндірме: ${explanation}` : ''}`,
    finished: 'Жаттығу аяқталды.', finishChannel: 'Бүгінгі викторина аяқталды. Өз қателеріңізді ботта талдаңыз.',
    openReview: 'Қатемен жұмысқа өту', channelQuestion: (n, total) => `🧮 ${n}/${total}`,
    adminOnly: 'Әкімші құқығы қажет.', adminOpen: 'Басқару панелін ашу',
    error: 'Қате орын алды. Кейінірек қайталап көріңіз.', blocked: 'Қолжетімділік шектелген.'
  },
  ru: {
    welcome: 'Привет! Выберите раздел.',
    menuRandom: '🎯 Случайные задачи', menuTopics: '📚 Темы', menuStats: '📊 Результаты', menuLanguage: '🌐 Язык',
    help: 'Команды: /random — случайные задачи, /topics — темы, /stats — результаты, /language — язык.',
    chooseLanguage: 'Выберите язык:', languageSaved: 'Язык сохранён.',
    chooseTopic: 'Выберите тему:', noTopics: 'Доступных тем пока нет.', back: '← Назад', previousPage: '← Предыдущая', nextPage: 'Следующая →',
    noQuestions: 'Нет опубликованных корректных вопросов.',
    question: (n) => `Вопрос ${n}`, next: 'Следующая задача →',
    correct: '✅ Верно!', wrong: '❌ Неверно!', alreadyAnswered: 'Вы уже ответили на этот вопрос.',
    closed: 'Время ответа на этот вопрос истекло.', invalid: 'Вопрос недоступен.',
    result: (correct, total) => `Результат: ${correct}/${total}`,
    stats: (correct, total) => `📊 Ответов: ${total}\n✅ Верных: ${correct}\n❌ Ошибок: ${total - correct}`,
    reviewTitle: (correct, total) => `Сегодняшняя викторина: ${correct}/${total}.`,
    reviewOffer: (count) => `Вы ошиблись в ${count} вопросах. Хотите решить похожие задачи?`,
    noMistakes: 'Ошибок нет. Отлично!', noSimilar: 'Других опубликованных задач по этим темам пока нет.',
    similar: 'Похожие задачи', review: 'Работа над ошибками', notAnswered: 'Нет ответа', languageKk: 'Қазақша', languageRu: 'Русский', languageEn: 'English',
    reviewQuestion: (text, selected, right, explanation) => `❌ ${text}\n\nВаш ответ: ${selected}\nПравильный ответ: ${right}${explanation ? `\nОбъяснение: ${explanation}` : ''}`,
    finished: 'Практика завершена.', finishChannel: 'Сегодняшняя викторина завершена. Разберите ошибки в боте.',
    openReview: 'Перейти к разбору', channelQuestion: (n, total) => `🧮 ${n}/${total}`,
    adminOnly: 'Нужны права администратора.', adminOpen: 'Открыть панель управления',
    error: 'Произошла ошибка. Попробуйте позже.', blocked: 'Доступ ограничен.'
  },
  en: {
    welcome: 'Hello! Choose a section.',
    menuRandom: '🎯 Random practice', menuTopics: '📚 Topics', menuStats: '📊 Results', menuLanguage: '🌐 Language',
    help: 'Commands: /random — random practice, /topics — topics, /stats — results, /language — language.',
    chooseLanguage: 'Choose a language:', languageSaved: 'Language saved.',
    chooseTopic: 'Choose a topic:', noTopics: 'No topics are available yet.', back: '← Back', previousPage: '← Previous', nextPage: 'Next →',
    noQuestions: 'No valid published questions are available.',
    question: (n) => `Question ${n}`, next: 'Next question →',
    correct: '✅ Correct!', wrong: '❌ Incorrect!', alreadyAnswered: 'You already answered this question.',
    closed: 'The answer window for this question has closed.', invalid: 'Question unavailable.',
    result: (correct, total) => `Result: ${correct}/${total}`,
    stats: (correct, total) => `📊 Answers: ${total}\n✅ Correct: ${correct}\n❌ Incorrect: ${total - correct}`,
    reviewTitle: (correct, total) => `Today's quiz: ${correct}/${total}.`,
    reviewOffer: (count) => `You missed ${count} questions. Would you like to try similar problems?`,
    noMistakes: 'No mistakes. Great work!', noSimilar: 'No other published problems on these topics are available yet.',
    similar: 'Similar problems', review: 'Review mistakes', notAnswered: 'No answer', languageKk: 'Қазақша', languageRu: 'Русский', languageEn: 'English',
    reviewQuestion: (text, selected, right, explanation) => `❌ ${text}\n\nYour answer: ${selected}\nCorrect answer: ${right}${explanation ? `\nExplanation: ${explanation}` : ''}`,
    finished: 'Practice finished.', finishChannel: "Today's quiz has ended. Review your mistakes in the bot.",
    openReview: 'Open review', channelQuestion: (n, total) => `🧮 ${n}/${total}`,
    adminOnly: 'Administrator access is required.', adminOpen: 'Open admin panel',
    error: 'Something went wrong. Please try again later.', blocked: 'Access restricted.'
  }
});

function normalizeLanguage(language) {
  const code = String(language || '').toLowerCase().split('-')[0];
  return Object.hasOwn(translations, code) ? code : 'kk';
}

function t(language, key, ...args) {
  const value = translations[normalizeLanguage(language)][key];
  if (value === undefined) throw new Error(`Missing translation: ${key}`);
  return typeof value === 'function' ? value(...args) : value;
}

module.exports = { t, normalizeLanguage };
