import { createContext, ReactNode, useContext } from 'react';

import type { OnboardingStatus, OnboardingUiState } from './onboarding.js';

export interface OnboardingContextValue {
  status: OnboardingStatus;
  uiState: OnboardingUiState;
  dismissSetup: () => void;
  resetOnboarding: () => void;
  replayOnboarding: () => void;
  completeOnboarding: () => void;
  dismissRibbon: (id: string) => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({ value, children }: { value: OnboardingContextValue; children: ReactNode }) {
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboardingContext(): OnboardingContextValue | null {
  return useContext(OnboardingContext);
}
