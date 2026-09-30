import { db, ref, get, set, update, remove, push } from '../lib/firebase';
import { onValue } from 'firebase/database';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../lib/firebase';

const integerFields = {
  questionCount: { label: 'Questions per quiz', min: 1, max: 50 },
  intervalMinutes: { label: 'Minutes between questions', min: 1, max: 1440 },
  answerWindowMinutes: { label: 'Answer window in minutes', min: 1, max: 1440 }
};

export function validateCampaign(input, eligibleQuestionCount = null) {
  const errors = {};
  const name = String(input.name ?? '').trim();
  const channelId = String(input.channelId ?? '').trim();
  const timezone = String(input.timezone ?? '').trim();
  const localTime = String(input.localTime ?? '').trim();
  const language = String(input.language ?? '').trim();

  if (!name || name.length > 120) errors.name = 'Enter a name of up to 120 characters.';
  if (!/^(@[A-Za-z0-9_]{5,32}|-100\d{1,20})$/.test(channelId)) {
    errors.channelId = 'Enter a channel @username or numeric ID beginning with -100.';
  }
  if (!timezone) {
    errors.timezone = 'Enter an IANA time zone such as Asia/Almaty.';
  } else {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      errors.timezone = 'Enter a valid IANA time zone.';
    }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    errors.localTime = 'Enter a local time in 24-hour HH:mm format.';
  }
  if (!['kk', 'ru', 'en'].includes(language)) {
    errors.language = 'Choose the language used in channel quiz messages.';
  }

  const values = { name, channelId, timezone, localTime, language, enabled: input.enabled === true };
  for (const [field, limits] of Object.entries(integerFields)) {
    const raw = String(input[field] ?? '').trim();
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < limits.min || value > limits.max) {
      errors[field] = `${limits.label} must be between ${limits.min} and ${limits.max}.`;
    } else {
      values[field] = value;
    }
  }
  if (Number.isInteger(eligibleQuestionCount) && values.questionCount > eligibleQuestionCount) {
    errors.questionCount = `At most ${eligibleQuestionCount} questions can be used while reserving one similar problem per topic.`;
  }

  return { values, errors, valid: Object.keys(errors).length === 0 };
}

function validatedValues(input, eligibleQuestionCount) {
  const result = validateCampaign(input, eligibleQuestionCount);
  if (!result.valid) {
    const error = new Error('Fix the highlighted fields before saving.');
    error.fields = result.errors;
    throw error;
  }
  return result.values;
}

function isEligibleQuestion(id, question) {
  const text = typeof question?.text === 'string' ? question.text.trim() : '';
  const imageUrl = typeof question?.imageUrl === 'string' ? question.imageUrl.trim() : '';
  let validImageUrl = !imageUrl;
  if (imageUrl) {
    try {
      validImageUrl = new URL(imageUrl).protocol === 'https:';
    } catch {
      validImageUrl = false;
    }
  }
  return /^[A-Za-z0-9_-]{1,50}$/.test(id)
    && question?.status === 'published'
    && (Boolean(text) || Boolean(imageUrl))
    && text.length <= 3500
    && validImageUrl
    && Array.isArray(question.options)
    && question.options.length === 4
    && question.options.every(option => typeof option === 'string' && option.trim().length > 0 && option.length <= 500)
    && Number.isInteger(question.correctOption)
    && question.correctOption >= 0
    && question.correctOption < 4;
}

function eligibleCount(snapshot) {
  if (!snapshot.exists()) return 0;
  const byTopic = new Map();
  for (const [id, question] of Object.entries(snapshot.val())) {
    if (!isEligibleQuestion(id, question)) continue;
    const topicId = String(question.topicId || question.topic || '');
    if (topicId) byTopic.set(topicId, (byTopic.get(topicId) || 0) + 1);
  }
  return [...byTopic.values()].reduce((count, topicCount) => count + Math.max(0, topicCount - 1), 0);
}

async function getEligibleQuestionCount() {
  return eligibleCount(await get(ref(db, 'questions')));
}

export function subscribeToEligibleQuestionCount(onData, onError) {
  return onValue(ref(db, 'questions'), snapshot => onData(eligibleCount(snapshot)), onError);
}

export async function getCampaigns() {
  const snapshot = await get(ref(db, 'campaigns'));
  if (!snapshot.exists()) return [];
  return Object.entries(snapshot.val()).map(([id, campaign]) => ({ id, ...campaign }));
}

export function subscribeToCampaigns(onData, onError) {
  return onValue(ref(db, 'campaigns'), snapshot => {
    const campaigns = snapshot.exists()
      ? Object.entries(snapshot.val()).map(([id, campaign]) => ({ id, ...campaign }))
      : [];
    onData(campaigns);
  }, onError);
}

export function subscribeToPublications(onData, onError) {
  return onValue(ref(db, 'publications'), snapshot => {
    const publications = snapshot.exists()
      ? Object.entries(snapshot.val()).map(([id, publication]) => ({ id, ...publication }))
      : [];
    onData(publications);
  }, onError);
}

export async function createCampaign(input) {
  const values = validatedValues(input, await getEligibleQuestionCount());
  if (values.enabled) await verifyChannel(values.channelId);
  const campaignRef = push(ref(db, 'campaigns'));
  const now = Date.now();
  await set(campaignRef, { ...values, createdAt: now, updatedAt: now });
  return campaignRef.key;
}

export async function updateCampaign(id, input) {
  if (!id || [...id].some(character => '.#$[]/'.includes(character))) throw new Error('Invalid campaign ID.');
  const values = validatedValues(input, await getEligibleQuestionCount());
  if (values.enabled) await verifyChannel(values.channelId);
  await update(ref(db, `campaigns/${id}`), { ...values, updatedAt: Date.now() });
}

export async function setCampaignEnabled(campaign, enabled) {
  if (!campaign?.id || [...campaign.id].some(character => '.#$[]/'.includes(character))) throw new Error('Invalid campaign ID.');
  if (enabled) {
    const values = validatedValues({ ...campaign, enabled }, await getEligibleQuestionCount());
    await verifyChannel(values.channelId);
  }
  await update(ref(db, `campaigns/${campaign.id}`), { enabled: enabled === true, updatedAt: Date.now() });
}

export async function deleteCampaign(id) {
  if (!id || [...id].some(character => '.#$[]/'.includes(character))) throw new Error('Invalid campaign ID.');
  await remove(ref(db, `campaigns/${id}`));
}

export async function verifyChannel(channelId) {
  const result = await httpsCallable(functions, 'verifyChannel')({ channelId: String(channelId || '').trim() });
  if (result.data?.canPost !== true || typeof result.data?.channelId !== 'string') {
    throw new Error('The channel could not be verified.');
  }
  return result.data;
}
