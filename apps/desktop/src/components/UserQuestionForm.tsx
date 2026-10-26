import { useState } from 'react';
import controls from './ui/controls.module.css';
import { isComplete, joinSelection, type QuestionAnswers, type UserQuestion } from './user-question';
import styles from './UserQuestionForm.module.css';

interface UserQuestionFormProps {
  questions: UserQuestion[];
  busy: boolean;
  onAnswer: (answers: QuestionAnswers) => void;
  onSkip: () => void;
}

interface Choice {
  selected: string[];
  other: string;
}

const EMPTY_CHOICE: Choice = { selected: [], other: '' };

function answerOf(question: UserQuestion, choice: Choice): string {
  if (question.multiSelect) {
    return joinSelection(choice.selected, choice.other);
  }
  return choice.other.trim() || (choice.selected[0] ?? '');
}

export function UserQuestionForm({ questions, busy, onAnswer, onSkip }: UserQuestionFormProps) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const answersOnClick = questions.length === 1 && questions[0]?.multiSelect === false;

  const choiceOf = (question: UserQuestion) => choices[question.question] ?? EMPTY_CHOICE;
  const answers: QuestionAnswers = Object.fromEntries(
    questions.map((question) => [question.question, answerOf(question, choiceOf(question))]),
  );

  const update = (question: UserQuestion, change: Partial<Choice>) =>
    setChoices((current) => ({
      ...current,
      [question.question]: { ...(current[question.question] ?? EMPTY_CHOICE), ...change },
    }));

  const pick = (question: UserQuestion, label: string) => {
    if (answersOnClick) {
      onAnswer({ [question.question]: label });
      return;
    }
    const { selected } = choiceOf(question);
    if (question.multiSelect) {
      update(question, {
        selected: selected.includes(label)
          ? selected.filter((entry) => entry !== label)
          : [...selected, label],
      });
    } else {
      update(question, { selected: [label], other: '' });
    }
  };

  return (
    <form
      className={styles.form}
      aria-label="Question de l’agent"
      onSubmit={(event) => {
        event.preventDefault();
        if (isComplete(questions, answers)) {
          onAnswer(answers);
        }
      }}
    >
      {questions.map((question) => {
        const choice = choiceOf(question);
        return (
          <fieldset key={question.question} className={styles.question} disabled={busy}>
            <legend className={styles.legend}>
              {question.header && <span className={styles.header}>{question.header}</span>}
              <span className={styles.text}>{question.question}</span>
              {question.multiSelect && <span className={styles.hint}>plusieurs choix possibles</span>}
            </legend>
            <div className={styles.options}>
              {question.options.map((option) => {
                const selected = choice.selected.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    className={selected ? `${styles.option} ${styles.selected}` : styles.option}
                    aria-pressed={answersOnClick ? undefined : selected}
                    onClick={() => pick(question, option.label)}
                  >
                    <span className={styles.label}>{option.label}</span>
                    {option.description && <span className={styles.description}>{option.description}</span>}
                  </button>
                );
              })}
            </div>
            <input
              className={`${controls.input} ${styles.other}`}
              aria-label={`Autre réponse : ${question.question}`}
              placeholder="Autre réponse…"
              value={choice.other}
              onChange={(event) =>
                update(question, {
                  other: event.target.value,
                  ...(question.multiSelect ? {} : { selected: [] }),
                })
              }
            />
          </fieldset>
        );
      })}
      <div className={styles.actions}>
        <button type="button" className={controls.ghostSm} disabled={busy} onClick={onSkip}>
          Ignorer
        </button>
        <button
          type="submit"
          className={controls.primarySm}
          disabled={busy || !isComplete(questions, answers)}
        >
          Répondre
        </button>
      </div>
    </form>
  );
}
