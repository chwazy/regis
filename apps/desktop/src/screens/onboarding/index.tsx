import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AppSettingsInfo } from '@regis/shared';
import { loadAppInfoOnce } from '../../lib/app-info';
import { invokeCmd } from '../../lib/ipc';
import { DEFAULT_TIMEZONE, supportedTimezones, systemTimezone } from '../../lib/timezones';
import { firstVisibleRoute, parseUiScreens, UI_SCREENS_KEY, type UiScreens } from '../../lib/ui-screens';
import { StepAgents, type DefaultWrite } from './StepAgents';
import { StepConnectors } from './StepConnectors';
import { StepData } from './StepData';
import { StepPrereqs } from './StepPrereqs';
import { StepProfile } from './StepProfile';
import { StepSummary } from './StepSummary';
import {
  DEFAULT_AGENT_KEY,
  ONBOARDING_COMPLETED_KEY,
  ONBOARDING_PROFILE_KEY,
  STEPS,
  STEP_LABELS,
  isKnownTimezone,
  parseResumeQuery,
  profileById,
  type ProfileId,
  type StepId,
} from './onboarding-model';
import styles from './onboarding.module.css';

const TIMEZONE_KEY = 'app.timezone';
const DEFAULT_WRITE_KEY = 'policy.defaultWrite';

interface WizardState {
  profileId: ProfileId;
  screens: UiScreens;
  timezone: string;
  defaultAgentId: string;
  defaultWrite: DefaultWrite;
}

const getSetting = (key: string) => invokeCmd<string | null>('get_setting', { key });
const setSetting = (key: string, value: string) => invokeCmd<void>('set_setting', { key, value });

async function loadInitialState(search: string): Promise<WizardState> {
  const resume = parseResumeQuery(search);
  const [completedAt, storedProfile, rawScreens, storedTimezone, storedAgent, rawWrite] = await Promise.all([
    getSetting(ONBOARDING_COMPLETED_KEY),
    getSetting(ONBOARDING_PROFILE_KEY),
    getSetting(UI_SCREENS_KEY),
    getSetting(TIMEZONE_KEY),
    getSetting(DEFAULT_AGENT_KEY),
    getSetting(DEFAULT_WRITE_KEY),
  ]);
  const relaunch = completedAt !== null && completedAt !== '';
  const profile = profileById(resume.profile ?? storedProfile);
  const screens = relaunch && resume.profile === null ? parseUiScreens(rawScreens) : { ...profile.screens };
  return {
    profileId: profile.id,
    screens,
    timezone: storedTimezone !== null && storedTimezone !== '' ? storedTimezone : systemTimezone(),
    defaultAgentId: storedAgent ?? '',
    defaultWrite: rawWrite === 'deny' ? 'deny' : 'ask',
  };
}

async function persistProfileStep(state: WizardState): Promise<void> {
  const available = supportedTimezones();
  if (
    state.timezone !== DEFAULT_TIMEZONE &&
    available.length > 0 &&
    !isKnownTimezone(state.timezone, available)
  ) {
    throw new Error(`Fuseau horaire inconnu : ${state.timezone}`);
  }
  await setSetting(ONBOARDING_PROFILE_KEY, state.profileId);
  await setSetting(UI_SCREENS_KEY, JSON.stringify(state.screens));
  await setSetting(TIMEZONE_KEY, state.timezone);
}

async function persistAgentsStep(state: WizardState): Promise<void> {
  if (state.defaultAgentId !== '') {
    await setSetting(DEFAULT_AGENT_KEY, state.defaultAgentId);
  }
  await setSetting(DEFAULT_WRITE_KEY, state.defaultWrite);
}

export default function OnboardingScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<WizardState | null>(null);
  const [step, setStep] = useState<StepId>(() => parseResumeQuery(location.search).step ?? 'profile');
  const [info, setInfo] = useState<AppSettingsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    loadInitialState(location.search)
      .then((initial) => active && setState(initial))
      .catch((reason: unknown) => active && setError(String(reason)));
    loadAppInfoOnce()
      .then((loaded) => active && setInfo(loaded))
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // L'état initial n'est lu qu'une fois : les changements de recherche ne le réinitialisent pas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((current) => (current ? { ...current, ...patch } : current));
  }, []);
  const setDefaultAgent = useCallback((defaultAgentId: string) => update({ defaultAgentId }), [update]);

  if (state === null) {
    return (
      <div className={styles.page}>
        <div className={styles.wizard}>
          {error !== null ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : (
            <p className={styles.hint}>Chargement…</p>
          )}
        </div>
      </div>
    );
  }

  const profile = profileById(state.profileId);
  const index = STEPS.indexOf(step);
  const last = index === STEPS.length - 1;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const persistStep = async (current: StepId) => {
    if (current === 'data') {
      await persistProfileStep(state);
    } else if (current === 'agents') {
      await persistAgentsStep(state);
    }
  };

  const goTo = (target: StepId) => {
    setStep(target);
    setError(null);
  };

  const next = () =>
    run(async () => {
      await persistStep(step);
      goTo(STEPS[index + 1] ?? step);
    });

  const skipStep = () => goTo(STEPS[index + 1] ?? step);
  const previous = () => goTo(STEPS[index - 1] ?? step);

  const finish = () =>
    run(async () => {
      await persistProfileStep(state);
      await persistAgentsStep(state);
      await setSetting(ONBOARDING_COMPLETED_KEY, new Date().toISOString());
      navigate(firstVisibleRoute(state.screens), { replace: true });
    });

  const skipWizard = () =>
    run(async () => {
      await setSetting(ONBOARDING_PROFILE_KEY, state.profileId);
      await setSetting(ONBOARDING_COMPLETED_KEY, new Date().toISOString());
      navigate(firstVisibleRoute(parseUiScreens(await getSetting(UI_SCREENS_KEY))), { replace: true });
    });

  return (
    <div className={styles.page}>
      <main className={styles.wizard}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.brand}>Bienvenue dans Régis</h1>
            <p className={styles.subtitle}>Première utilisation : quelques étapes pour tout configurer.</p>
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => void skipWizard()}
          >
            Passer l’assistant
          </button>
        </div>

        <div className={styles.progress}>
          <div
            className={styles.progressBar}
            role="progressbar"
            aria-label="Progression de l’assistant"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={index + 1}
          >
            <div
              className={styles.progressFill}
              style={{ width: `${((index + 1) * 100) / STEPS.length}%` }}
            />
          </div>
          <ol className={styles.stepList}>
            {STEPS.map((id, position) => (
              <li
                key={id}
                className={id === step ? styles.stepCurrent : undefined}
                {...(id === step ? { 'aria-current': 'step' as const } : {})}
              >
                {position + 1}. {STEP_LABELS[id]}
              </li>
            ))}
          </ol>
        </div>

        {error !== null && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        {step === 'profile' && (
          <StepProfile
            profileId={state.profileId}
            screens={state.screens}
            onProfile={(id) => update({ profileId: id, screens: { ...profileById(id).screens } })}
            onScreens={(screens) => update({ screens })}
          />
        )}
        {step === 'data' && (
          <StepData
            info={info}
            profileId={state.profileId}
            timezone={state.timezone}
            onTimezone={(timezone) => update({ timezone })}
          />
        )}
        {step === 'prereqs' && <StepPrereqs brainVisible={state.screens.brain} />}
        {step === 'connectors' && <StepConnectors profile={profile} />}
        {step === 'agents' && (
          <StepAgents
            defaultAgentId={state.defaultAgentId}
            defaultWrite={state.defaultWrite}
            onDefaultAgent={setDefaultAgent}
            onDefaultWrite={(defaultWrite) => update({ defaultWrite })}
          />
        )}
        {step === 'summary' && (
          <StepSummary
            profile={profile}
            screens={state.screens}
            timezone={state.timezone}
            defaultAgentId={state.defaultAgentId}
            defaultWrite={state.defaultWrite}
          />
        )}

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy || index === 0}
            onClick={previous}
          >
            Précédent
          </button>
          <span className={styles.spacer} />
          {last ? (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy}
              onClick={() => void finish()}
            >
              Terminer
            </button>
          ) : (
            <>
              <button type="button" className={styles.linkButton} disabled={busy} onClick={skipStep}>
                Passer cette étape
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={busy}
                onClick={() => void next()}
              >
                Suivant
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
