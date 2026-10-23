import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { loadAppInfoOnce } from '../lib/app-info';
import { invokeCmd } from '../lib/ipc';
import { ONBOARDING_COMPLETED_KEY, shouldShowOnboarding } from '../screens/onboarding/onboarding-model';

const WIZARD_PATH = '/bienvenue';

type Decision = { show: false } | { show: true; target: string };

// L'assistant n'est évalué qu'au lancement : une fois décidé, naviguer vers le shell
// (fin de l'assistant, lien vers Connecteurs) ne relance pas la redirection.
let evaluated = false;

async function decide(): Promise<Decision> {
  const info = await loadAppInfoOnce();
  if (info.demo && !info.forceOnboarding) {
    return { show: false };
  }
  const completedAt = await invokeCmd<string | null>('get_setting', { key: ONBOARDING_COMPLETED_KEY });
  const completed = completedAt !== null && completedAt !== '' ? completedAt : null;
  if (info.resumeUrl !== null || shouldShowOnboarding(completed, info.forceOnboarding)) {
    return { show: true, target: info.resumeUrl ?? WIZARD_PATH };
  }
  return { show: false };
}

export function OnboardingGate({ children }: { children: ReactNode }) {
  const [decision, setDecision] = useState<Decision | null>(evaluated ? { show: false } : null);

  useEffect(() => {
    if (evaluated) {
      return;
    }
    let active = true;
    decide()
      .catch((): Decision => ({ show: false }))
      .then((result) => {
        evaluated = true;
        if (active) {
          setDecision(result);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (decision === null) {
    return null;
  }
  return decision.show ? <Navigate to={decision.target} replace /> : <>{children}</>;
}
