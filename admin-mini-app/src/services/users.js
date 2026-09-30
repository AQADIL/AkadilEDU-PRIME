import { equalTo, orderByChild, query } from 'firebase/database';
import { db, get, ref, update } from '../lib/firebase';

function validUserId(value) {
  const id = String(value);
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new Error('Invalid Telegram user ID.');
  }
  return id;
}

export async function getUsers() {
  const snapshot = await get(ref(db, 'users'));
  if (!snapshot.exists()) return [];
  return Object.entries(snapshot.val())
    .filter(([id]) => /^[1-9]\d{0,15}$/.test(id))
    .map(([id, user]) => ({ ...user, id }))
    .sort((left, right) => (right.lastActiveAt || 0) - (left.lastActiveAt || 0));
}

export async function setUserBlocked(id, blocked) {
  await update(ref(db, `users/${validUserId(id)}`), { isBlocked: blocked === true });
}

export async function getUserResults(id) {
  const userId = validUserId(id);
  const [practiceSnapshot, channelSnapshot] = await Promise.all([
    get(ref(db, `practiceAttempts/${userId}`)),
    get(query(ref(db, 'channelQuizAttempts'), orderByChild('userId'), equalTo(Number(userId))))
  ]);
  const practice = practiceSnapshot.exists() ? Object.values(practiceSnapshot.val()) : [];
  const channel = channelSnapshot.exists() ? Object.values(channelSnapshot.val()) : [];
  const answers = [...practice, ...channel.flatMap(attempt => Object.values(attempt.answers || {}))];
  return {
    answered: answers.length,
    correct: answers.filter(answer => answer.isCorrect === true).length,
    channelQuizzes: channel.length
  };
}
