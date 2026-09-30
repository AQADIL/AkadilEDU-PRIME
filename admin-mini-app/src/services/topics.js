import { onValue, runTransaction } from 'firebase/database';
import { db, ref, get, push } from '../lib/firebase';

const topicIdPattern = /^[A-Za-z0-9_-]{1,50}$/;

function validateTopicId(topicId) {
  if (typeof topicId !== 'string' || !topicIdPattern.test(topicId)) {
    throw new Error('Topic ID must use 1–50 letters, numbers, underscores, or hyphens.');
  }
  return topicId;
}

function validateTopicData(topicData) {
  if (!topicData || typeof topicData !== 'object' || Array.isArray(topicData)) {
    throw new Error('Topic data is required.');
  }
  const name = typeof topicData.name === 'string' ? topicData.name.trim() : '';
  if (!name || name.length > 120) {
    throw new Error('Enter a topic name of up to 120 characters.');
  }
  if (typeof topicData.visible !== 'boolean') {
    throw new Error('Choose whether the topic is visible.');
  }
  const parentId = topicData.parentId ?? '';
  if (typeof parentId !== 'string') {
    throw new Error('Parent topic ID is invalid.');
  }
  if (parentId) validateTopicId(parentId);
  const customIdInput = topicData.customId ?? '';
  if (typeof customIdInput !== 'string') {
    throw new Error('Custom topic ID is invalid.');
  }
  const customId = customIdInput.trim();
  if (customIdInput && !customId) {
    throw new Error('Custom topic ID cannot be blank.');
  }
  if (customId) validateTopicId(customId);
  return { name, parentId, customId, visible: topicData.visible };
}

async function hasQuestionReference(topicId) {
  const snapshot = await get(ref(db, 'questions'));
  return snapshot.exists() && Object.values(snapshot.val()).some(question =>
    question && (question.topic === topicId || question.topicId === topicId));
}

async function assertUnreferenced(topicId) {
  const [questionsSnapshot, campaignsSnapshot, materialsSnapshot] = await Promise.all([
    get(ref(db, 'questions')),
    get(ref(db, 'campaigns')),
    get(ref(db, 'materials')),
  ]);

  if (questionsSnapshot.exists() && Object.values(questionsSnapshot.val()).some(question =>
    question && (question.topic === topicId || question.topicId === topicId))) {
    throw new Error('Move or delete the questions in this topic first.');
  }
  if (campaignsSnapshot.exists() && Object.values(campaignsSnapshot.val()).some(campaign =>
    campaign?.topicId === topicId)) {
    throw new Error('Remove this topic from its campaigns first.');
  }
  if (materialsSnapshot.exists() && Object.values(materialsSnapshot.val()).some(material =>
    material && (material.topic === topicId || material.topicId === topicId))) {
    throw new Error('Move or delete the materials in this topic first.');
  }
}

export async function getTopics() {
  const snapshot = await get(ref(db, 'topics'));
  if (!snapshot.exists()) return [];
  return Object.entries(snapshot.val()).map(([id, topic]) => ({ id, ...topic }));
}

async function runTopicsTransaction(updateTopics) {
  const topicsRef = ref(db, 'topics');
  let unsubscribe;
  const initialValue = new Promise((resolve, reject) => {
    unsubscribe = onValue(topicsRef, resolve, reject);
  });
  try {
    await initialValue;
    return await runTransaction(topicsRef, updateTopics, { applyLocally: false });
  } finally {
    unsubscribe?.();
  }
}

export async function createTopic(topicData) {
  const { name, parentId, customId, visible } = validateTopicData(topicData);
  if (parentId && await hasQuestionReference(parentId)) {
    throw new Error('Move questions out of the parent topic before adding a subtopic.');
  }
  const topicId = customId || push(ref(db, 'topics')).key;
  if (!topicId) throw new Error('Could not allocate a topic ID.');
  const now = Date.now();
  let conflict = 'Topic could not be created. Retry after refreshing the page.';
  const result = await runTopicsTransaction(current => {
    const topics = current || {};
    if (topics[topicId]) {
      conflict = 'This topic ID already exists.';
      return;
    }
    if (parentId && !topics[parentId]) {
      conflict = 'Parent topic no longer exists.';
      return;
    }
    const next = {
      ...topics,
      [topicId]: { name, parentId, visible, isActive: visible, isLast: true, createdAt: now, updatedAt: now },
    };
    if (parentId) {
      next[parentId] = { ...topics[parentId], isLast: false, updatedAt: now };
    }
    return next;
  });
  if (!result.committed) throw new Error(conflict);
  return topicId;
}

export async function updateTopic(topicId, topicData) {
  validateTopicId(topicId);
  const { name, parentId, customId, visible } = validateTopicData(topicData);
  if (customId && customId !== topicId) {
    throw new Error('Topic IDs are permanent. Change the topic name instead.');
  }
  if (parentId === topicId) {
    throw new Error('A topic cannot be its own parent.');
  }
  const existingSnapshot = await get(ref(db, `topics/${topicId}`));
  if (!existingSnapshot.exists()) {
    throw new Error('Topic no longer exists.');
  }
  if (parentId && parentId !== (existingSnapshot.val().parentId || '')
    && await hasQuestionReference(parentId)) {
    throw new Error('Move questions out of the parent topic before moving a subtopic there.');
  }

  const now = Date.now();
  let conflict = 'Topic could not be updated. Retry after refreshing the page.';
  const result = await runTopicsTransaction(current => {
    const topics = current || {};
    const existing = topics[topicId];
    if (!existing) {
      conflict = 'Topic no longer exists.';
      return;
    }
    let ancestorId = parentId;
    const visited = new Set();
    while (ancestorId) {
      if (ancestorId === topicId || visited.has(ancestorId)) {
        conflict = 'A topic cannot be moved under one of its descendants.';
        return;
      }
      visited.add(ancestorId);
      const ancestor = topics[ancestorId];
      if (!ancestor) {
        conflict = 'Parent topic no longer exists.';
        return;
      }
      ancestorId = ancestor.parentId || '';
    }

    const next = {
      ...topics,
      [topicId]: { ...existing, name, parentId, visible, isActive: visible, updatedAt: now },
    };
    const oldParentId = existing.parentId || '';
    if (oldParentId !== parentId) {
      if (oldParentId && topics[oldParentId]) {
        const hasOtherChildren = Object.entries(topics).some(([id, topic]) =>
          id !== topicId && topic?.parentId === oldParentId);
        next[oldParentId] = { ...topics[oldParentId], isLast: !hasOtherChildren, updatedAt: now };
      }
      if (parentId) {
        next[parentId] = { ...topics[parentId], isLast: false, updatedAt: now };
      }
    }
    return next;
  });
  if (!result.committed) throw new Error(conflict);
  return topicId;
}

export async function deleteTopic(topicId) {
  validateTopicId(topicId);
  await assertUnreferenced(topicId);
  const now = Date.now();
  let conflict = 'Topic could not be deleted. Retry after refreshing the page.';
  const result = await runTopicsTransaction(current => {
    const topics = current || {};
    const existing = topics[topicId];
    if (!existing) {
      conflict = 'Topic no longer exists.';
      return;
    }
    if (Object.values(topics).some(topic => topic?.parentId === topicId)) {
      conflict = 'Delete or move the subtopics first.';
      return;
    }
    const next = { ...topics };
    delete next[topicId];
    const parentId = existing.parentId || '';
    if (parentId && topics[parentId]) {
      const hasOtherChildren = Object.values(next).some(topic => topic?.parentId === parentId);
      next[parentId] = { ...topics[parentId], isLast: !hasOtherChildren, updatedAt: now };
    }
    return next;
  });
  if (!result.committed) throw new Error(conflict);
}
