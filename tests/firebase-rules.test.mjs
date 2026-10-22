import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';

const projectId = process.env.GCLOUD_PROJECT;
if (!/^demo-[a-z0-9-]+$/.test(projectId ?? '')) {
  throw new Error('Security-rule checks require a demo emulator project');
}
for (const name of ['FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  const value = process.env[name];
  if (!value || value.includes('://')) throw new Error(`${name} must specify a local emulator`);
  const endpoint = new URL(`http://${value}`);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || !/^\d+$/.test(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error(`${name} must specify a local emulator`);
  }
}

const identities = {
  administrator: randomUUID(),
  superAdministrator: randomUUID(),
  ordinaryUser: randomUUID(),
  claimWithoutMembership: randomUUID(),
  membershipWithoutClaim: randomUUID(),
};
const questionId = randomUUID();
const publicObject = `questions/${questionId}/statement.txt`;
const privateObject = `private/${randomUUID()}.txt`;
let environment;

describe('Firebase access rules', { concurrency: false, timeout: 60000 }, () => {
  before(async () => {
    environment = await initializeTestEnvironment({
      projectId,
      database: { rules: await readFile(new URL('../database.rules.json', import.meta.url), 'utf8') },
      storage: { rules: await readFile(new URL('../storage.rules', import.meta.url), 'utf8') },
    });
    await Promise.all([environment.clearDatabase(), environment.clearStorage()]);
    await environment.withSecurityRulesDisabled(async context => {
      await context.database().ref().set({
        admins: {
          [identities.administrator]: { role: 'admin' },
          [identities.superAdministrator]: { role: 'super_admin' },
          [identities.membershipWithoutClaim]: { role: 'admin' },
        },
        questions: { [questionId]: { status: 'draft' } },
      });
      await Promise.all([
        context.storage().ref(publicObject).putString('Statement asset', 'raw', { contentType: 'text/plain' }),
        context.storage().ref(privateObject).putString('Restricted asset', 'raw', { contentType: 'text/plain' }),
      ]);
    });
  });

  after(async () => {
    if (!environment) return;
    try {
      await Promise.all([environment.clearDatabase(), environment.clearStorage()]);
    } finally {
      await environment.cleanup();
    }
  });

  it('denies unauthenticated and ordinary-user database reads', async () => {
    for (const context of [
      environment.unauthenticatedContext(),
      environment.authenticatedContext(identities.ordinaryUser),
    ]) {
      await assertFails(context.database().ref('questions').once('value'));
    }
  });

  it('requires both the administrator claim and current membership', async () => {
    await assertFails(environment.authenticatedContext(identities.claimWithoutMembership, { admin: true })
      .database().ref('questions').once('value'));
    await assertFails(environment.authenticatedContext(identities.membershipWithoutClaim)
      .database().ref('questions').once('value'));
  });

  it('allows a listed administrator to read and edit questions', async () => {
    const database = environment.authenticatedContext(identities.administrator, { admin: true }).database();
    await assertSucceeds(database.ref('questions').once('value'));
    await assertSucceeds(database.ref(`questions/${randomUUID()}`).set({ status: 'draft' }));
  });

  it('denies question writes without administrator membership and claim', async () => {
    for (const context of [
      environment.unauthenticatedContext(),
      environment.authenticatedContext(identities.ordinaryUser),
      environment.authenticatedContext(identities.claimWithoutMembership, { admin: true }),
      environment.authenticatedContext(identities.membershipWithoutClaim),
    ]) {
      await assertFails(context.database().ref(`questions/${randomUUID()}`).set({ status: 'draft' }));
    }
  });

  it('prevents ordinary administrators from changing administrator membership', async () => {
    const database = environment.authenticatedContext(identities.administrator, { admin: true }).database();
    await assertFails(database.ref(`admins/${randomUUID()}`).set({ role: 'admin' }));
  });

  it('allows a listed super administrator to manage administrator membership', async () => {
    const database = environment.authenticatedContext(identities.superAdministrator, { admin: true }).database();
    await assertSucceeds(database.ref(`admins/${randomUUID()}`).set({ role: 'admin' }));
  });

  it('denies direct browser-authentication request writes to every client role', async () => {
    for (const context of [
      environment.unauthenticatedContext(),
      environment.authenticatedContext(identities.ordinaryUser),
      environment.authenticatedContext(identities.administrator, { admin: true }),
      environment.authenticatedContext(identities.superAdministrator, { admin: true }),
    ]) {
      await assertFails(context.database().ref(`browserAuthRequests/${randomUUID()}`).set({ expiresAt: Date.now() }));
    }
  });

  it('serves question assets publicly while denying private-object reads', async () => {
    const storage = environment.unauthenticatedContext().storage();
    await assertSucceeds(storage.ref(publicObject).getMetadata());
    await assertFails(storage.ref(privateObject).getMetadata());
    await assertFails(environment.authenticatedContext(identities.ordinaryUser)
      .storage().ref(privateObject).getMetadata());
  });

  it('denies unauthenticated and ordinary-user uploads', async () => {
    for (const context of [
      environment.unauthenticatedContext(),
      environment.authenticatedContext(identities.ordinaryUser),
    ]) {
      await assertFails(context.storage().ref(`questions/${questionId}/${randomUUID()}.txt`).putString('Unauthorized upload'));
    }
  });

  it('allows uploads with an administrator claim', async () => {
    const storage = environment.authenticatedContext(identities.administrator, { admin: true }).storage();
    await assertSucceeds(storage.ref(`questions/${questionId}/${randomUUID()}.txt`).putString('Authorized upload'));
  });
});
