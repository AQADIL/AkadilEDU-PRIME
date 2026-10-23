import { config, studioRoot } from './config.js';
import type { StoredQuestion } from './schema.js';
import { renderQuestionWithSettings } from './renderCore.js';
export { closeRenderer, QuestionRenderError, DiagramLayoutError, RenderRetryError } from './renderCore.js';

export function renderQuestion(question: StoredQuestion) {
  return renderQuestionWithSettings(question, { ...config, studioRoot });
}
