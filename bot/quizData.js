const { randomInt } = require('node:crypto');
const { db } = require('./firebase');

const safeId = /^[A-Za-z0-9_-]{1,80}$/;

function assertId(id) {
  if (typeof id !== 'string' || !safeId.test(id)) throw new Error('Invalid database key');
  return id;
}

function validQuestion(id, question) {
  return safeId.test(id) && id.length <= 50 && question && question.status === 'published'
    && typeof question.text === 'string' && question.text.length <= 3500
    && (question.text.trim().length > 0 || (typeof question.imageUrl === 'string' && /^https:\/\//.test(question.imageUrl)))
    && Array.isArray(question.options)
    && question.options.length === 4
    && question.options.every((option) => typeof option === 'string' && option.trim().length > 0 && option.length <= 500)
    && Number.isInteger(question.correctOption)
    && question.correctOption >= 0 && question.correctOption < question.options.length
    && (!question.imageUrl || (typeof question.imageUrl === 'string' && /^https:\/\//.test(question.imageUrl)));
}

async function getQuestion(questionId) {
  const id = assertId(questionId);
  const snapshot = await db.ref(`questions/${id}`).once('value');
  const question = snapshot.val();
  return validQuestion(id, question) ? { id, ...question } : null;
}

async function listQuestions() {
  const snapshot = await db.ref('questions').once('value');
  const result = [];
  snapshot.forEach((child) => {
    if (validQuestion(child.key, child.val())) result.push({ id: child.key, ...child.val() });
  });
  return result;
}

function shuffle(items) {
  const values = [...items];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

function topicOf(question) {
  return String(question.topicId || question.topic || '');
}

function formatQuestion(header, question) {
  const options = question.options.map((option, index) => `${String.fromCharCode(65 + index)}) ${option}`);
  return [header, question.text?.trim(), ...options].filter(Boolean).join('\n\n');
}

function splitMessage(value) {
  const chunks = [];
  let remaining = value;
  while (remaining.length > 4000) {
    const boundary = remaining.lastIndexOf('\n', 4000);
    const length = boundary > 2000 ? boundary : 4000;
    chunks.push(remaining.slice(0, length));
    remaining = remaining.slice(length).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function findSimilar(allQuestions, sourceQuestions, excludedIds, limit) {
  const excluded = new Set(excludedIds);
  const topics = new Set(sourceQuestions.map(topicOf).filter(Boolean));
  const subtopics = new Set(sourceQuestions.map((question) => question.subtopicId).filter(Boolean));
  return shuffle(allQuestions.filter((question) => !excluded.has(question.id)
    && ((question.subtopicId && subtopics.has(question.subtopicId)) || topics.has(topicOf(question))))).slice(0, limit);
}

module.exports = { assertId, getQuestion, listQuestions, shuffle, topicOf, findSimilar, formatQuestion, splitMessage };
