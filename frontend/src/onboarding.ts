export type OnboardingStep = 'welcome' | 'server' | 'model' | 'first_run' | 'complete';

export interface OnboardingUiState {
  dismissedAt?: string;
  completedAt?: string;
  replaying?: boolean;
  resetBaseline?: {
    serverCount: number;
    modelCount: number;
  };
  ribbonsDismissed?: string[];
}

export interface OnboardingInputs {
  serverCount: number;
  modelCount: number;
  uiState: OnboardingUiState;
}

export interface OnboardingStatus {
  step: OnboardingStep;
  currentStepNumber: number;
  completedSteps: number;
  stepIndex: number;
  totalSteps: number;
  active: boolean;
  showWelcome: boolean;
  unlockedThrough: 'catalog' | 'templates' | 'run' | 'results' | 'evaluate';
}

export const ONBOARDING_STORAGE_KEY = 'inferharness.onboarding.v1';
export const ONBOARDING_FIRST_RUN_EVENT = 'inferharness:onboarding:first-run-success';

export function readOnboardingUiState(storage: Storage | undefined = globalThis.localStorage): OnboardingUiState {
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as OnboardingUiState;
    return {
      dismissedAt: typeof parsed.dismissedAt === 'string' ? parsed.dismissedAt : undefined,
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : undefined,
      replaying: parsed.replaying === true,
      resetBaseline: parsed.resetBaseline && typeof parsed.resetBaseline === 'object'
        ? {
          serverCount: typeof parsed.resetBaseline.serverCount === 'number' ? parsed.resetBaseline.serverCount : 0,
          modelCount: typeof parsed.resetBaseline.modelCount === 'number' ? parsed.resetBaseline.modelCount : 0
        }
        : undefined,
      ribbonsDismissed: Array.isArray(parsed.ribbonsDismissed)
        ? parsed.ribbonsDismissed.filter((entry): entry is string => typeof entry === 'string')
        : []
    };
  } catch {
    return {};
  }
}

export function writeOnboardingUiState(
  state: OnboardingUiState,
  storage: Storage | undefined = globalThis.localStorage
): OnboardingUiState {
  const next: OnboardingUiState = {
    ...state,
    ribbonsDismissed: state.ribbonsDismissed ?? []
  };
  storage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function deriveOnboardingStatus(input: OnboardingInputs): OnboardingStatus {
  const { uiState } = input;
  const baseline = uiState.resetBaseline;
  const serverCount = Math.max(0, input.serverCount - (baseline?.serverCount ?? 0));
  const modelCount = Math.max(0, input.modelCount - (baseline?.modelCount ?? 0));
  const completed = Boolean(uiState.completedAt) && uiState.replaying !== true;
  const dismissed = Boolean(uiState.dismissedAt) && uiState.replaying !== true;
  let step: OnboardingStep;

  if (completed) {
    step = 'complete';
  } else if (serverCount === 0 && modelCount === 0 && !dismissed) {
    step = 'welcome';
  } else if (serverCount === 0) {
    step = 'server';
  } else if (modelCount === 0) {
    step = 'model';
  } else {
    step = 'first_run';
  }

  const currentStepNumber = step === 'complete' ? 3
    : step === 'model' ? 2
      : step === 'first_run' ? 3
        : 1;
  const completedSteps = step === 'complete' ? 3
    : step === 'first_run' ? 2
      : step === 'model' ? 1
        : 0;
  const showWelcome = step === 'welcome';
  const active = !completed && !dismissed;
  const unlockedThrough = step === 'welcome' || step === 'server' || step === 'model'
    ? 'catalog'
    : step === 'first_run'
      ? 'run'
      : 'results';

  return {
    step,
    currentStepNumber,
    completedSteps,
    stepIndex: currentStepNumber,
    totalSteps: 3,
    active,
    showWelcome,
    unlockedThrough
  };
}

export function onboardingRouteForStep(step: OnboardingStep): string {
  if (step === 'welcome') {
    return '/welcome';
  }
  if (step === 'server') {
    return '/catalog?tab=servers&startOnboarding=1';
  }
  if (step === 'model') {
    return '/catalog?tab=models';
  }
  if (step === 'complete') {
    return '/results?tab=dashboard';
  }
  return '/run';
}

export function markRibbonDismissed(state: OnboardingUiState, ribbonId: string): OnboardingUiState {
  const ribbons = new Set(state.ribbonsDismissed ?? []);
  ribbons.add(ribbonId);
  return { ...state, ribbonsDismissed: Array.from(ribbons) };
}

export function isRibbonDismissed(state: OnboardingUiState, ribbonId: string): boolean {
  return (state.ribbonsDismissed ?? []).includes(ribbonId);
}
