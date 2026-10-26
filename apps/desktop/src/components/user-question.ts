export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

export interface QuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export type QuestionAnswers = Record<string, string>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOption(value: unknown): QuestionOption[] {
  const record = asRecord(value);
  if (!record || typeof record.label !== 'string') {
    return [];
  }
  return [
    { label: record.label, description: typeof record.description === 'string' ? record.description : '' },
  ];
}

function readQuestion(value: unknown): UserQuestion[] {
  const record = asRecord(value);
  if (!record || typeof record.question !== 'string') {
    return [];
  }
  return [
    {
      question: record.question,
      header: typeof record.header === 'string' ? record.header : '',
      multiSelect: record.multiSelect === true,
      options: Array.isArray(record.options) ? record.options.flatMap(readOption) : [],
    },
  ];
}

export function readUserQuestions(approval: { tool: string; inputJson: unknown }): UserQuestion[] | null {
  if (approval.tool !== ASK_USER_QUESTION_TOOL) {
    return null;
  }
  const questions = asRecord(approval.inputJson)?.questions;
  const parsed = Array.isArray(questions) ? questions.flatMap(readQuestion) : [];
  return parsed.length > 0 ? parsed : null;
}

export function answeredInput(input: unknown, answers: QuestionAnswers): Record<string, unknown> {
  return { ...asRecord(input), answers };
}

export function joinSelection(labels: string[], other: string): string {
  return [...labels, other.trim()].filter((label) => label !== '').join(', ');
}

export function isComplete(questions: UserQuestion[], answers: QuestionAnswers): boolean {
  return questions.every((question) => (answers[question.question] ?? '').trim() !== '');
}
