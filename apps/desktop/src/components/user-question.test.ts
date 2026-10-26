import { describe, expect, it } from 'vitest';
import { answeredInput, isComplete, joinSelection, readUserQuestions } from './user-question';

const CAPTURED_INPUT = {
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'Choose red.' },
        { label: 'Blue', description: 'Choose blue.' },
      ],
    },
  ],
};

describe('user questions', () => {
  it('reads the questions of an AskUserQuestion approval only', () => {
    expect(readUserQuestions({ tool: 'AskUserQuestion', inputJson: CAPTURED_INPUT })).toEqual(
      CAPTURED_INPUT.questions,
    );
    expect(readUserQuestions({ tool: 'mcp__fs__write_file', inputJson: CAPTURED_INPUT })).toBeNull();
    expect(readUserQuestions({ tool: 'AskUserQuestion', inputJson: { questions: [] } })).toBeNull();
  });

  it('builds the input Claude Code expects, answers keyed by question text', () => {
    expect(answeredInput(CAPTURED_INPUT, { 'Which color do you prefer?': 'Red' })).toEqual({
      ...CAPTURED_INPUT,
      answers: { 'Which color do you prefer?': 'Red' },
    });
  });

  it('joins a multi-select choice with the free text and checks completeness', () => {
    expect(joinSelection(['Red', 'Blue'], ' violet ')).toBe('Red, Blue, violet');
    expect(joinSelection([], '  ')).toBe('');
    const questions = readUserQuestions({ tool: 'AskUserQuestion', inputJson: CAPTURED_INPUT }) ?? [];
    expect(isComplete(questions, {})).toBe(false);
    expect(isComplete(questions, { 'Which color do you prefer?': 'Red' })).toBe(true);
  });
});
