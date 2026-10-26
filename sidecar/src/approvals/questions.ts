import { z } from 'zod';

export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

const questionInput = z.object({
  questions: z.array(z.object({ question: z.string() })),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});

export function isUserQuestion(tool: string): boolean {
  return tool === ASK_USER_QUESTION_TOOL;
}

export function hasAnswers(input: unknown): boolean {
  const parsed = questionInput.safeParse(input);
  return parsed.success && Object.keys(parsed.data.answers ?? {}).length > 0;
}

export function describeAnswers(input: unknown): string {
  const parsed = questionInput.safeParse(input);
  if (!parsed.success) {
    return '';
  }
  const answers = parsed.data.answers ?? {};
  return parsed.data.questions
    .flatMap(({ question }) => {
      const answer = answers[question];
      if (answer === undefined) {
        return [];
      }
      return [`« ${question} » = « ${Array.isArray(answer) ? answer.join(', ') : answer} »`];
    })
    .join(' ; ');
}
