import { expect, test } from 'vitest';

import {
  deriveOnboardingStatus,
  isRibbonDismissed,
  markRibbonDismissed,
  onboardingRouteForStep,
  readOnboardingUiState,
  writeOnboardingUiState
} from '../../src/onboarding.js';

function status(input: { servers: number; models: number; templates: number; completedAt?: string; dismissedAt?: string; replaying?: boolean }) {
  return deriveOnboardingStatus({
    serverCount: input.servers,
    modelCount: input.models,
    templateCount: input.templates,
    uiState: {
      completedAt: input.completedAt,
      dismissedAt: input.dismissedAt,
      replaying: input.replaying
    }
  });
}

test('derives onboarding steps from real app counts', () => {
  expect(status({ servers: 0, models: 0, templates: 0 }).step).toBe('welcome');
  expect(status({ servers: 0, models: 2, templates: 1 }).step).toBe('server');
  expect(status({ servers: 1, models: 0, templates: 0 }).step).toBe('model');
  expect(status({ servers: 1, models: 2, templates: 0 }).step).toBe('template');
  expect(status({ servers: 1, models: 2, templates: 1 }).step).toBe('first_run');
  expect(status({ servers: 1, models: 2, templates: 1, completedAt: '2026-01-01T00:00:00.000Z' }).step).toBe('complete');
});

test('separates current step from completed progress', () => {
  const empty = status({ servers: 0, models: 0, templates: 0 });
  expect(empty.currentStepNumber).toBe(1);
  expect(empty.completedSteps).toBe(0);

  const readyToRun = status({ servers: 1, models: 2, templates: 1 });
  expect(readyToRun.step).toBe('first_run');
  expect(readyToRun.currentStepNumber).toBe(4);
  expect(readyToRun.completedSteps).toBe(3);

  const complete = status({ servers: 1, models: 2, templates: 1, completedAt: '2026-01-01T00:00:00.000Z' });
  expect(complete.currentStepNumber).toBe(4);
  expect(complete.completedSteps).toBe(4);
});

test('reset baselines make existing setup count as unchecked', () => {
  const reset = deriveOnboardingStatus({
    serverCount: 1,
    modelCount: 25,
    templateCount: 1,
    uiState: {
      resetBaseline: {
        serverCount: 1,
        modelCount: 25,
        templateCount: 1
      }
    }
  });
  expect(reset.step).toBe('welcome');
  expect(reset.completedSteps).toBe(0);

  const afterNewServer = deriveOnboardingStatus({
    serverCount: 2,
    modelCount: 25,
    templateCount: 1,
    uiState: {
      resetBaseline: {
        serverCount: 1,
        modelCount: 25,
        templateCount: 1
      }
    }
  });
  expect(afterNewServer.step).toBe('model');
  expect(afterNewServer.completedSteps).toBe(1);
});

test('dismissed onboarding stops active welcome unless replaying', () => {
  expect(status({ servers: 0, models: 0, templates: 0, dismissedAt: '2026-01-01T00:00:00.000Z' }).active).toBe(false);
  const replay = status({ servers: 0, models: 0, templates: 0, dismissedAt: '2026-01-01T00:00:00.000Z', replaying: true });
  expect(replay.active).toBe(true);
  expect(replay.step).toBe('welcome');
});

test('maps onboarding steps to reset destinations', () => {
  expect(onboardingRouteForStep('welcome')).toBe('/welcome');
  expect(onboardingRouteForStep('server')).toBe('/catalog?tab=servers&startOnboarding=1');
  expect(onboardingRouteForStep('model')).toBe('/catalog?tab=models');
  expect(onboardingRouteForStep('template')).toBe('/run');
  expect(onboardingRouteForStep('first_run')).toBe('/run');
  expect(onboardingRouteForStep('complete')).toBe('/results?tab=dashboard');
});

test('ribbon dismissal is stable and idempotent', () => {
  const state = markRibbonDismissed({}, 'server-saved');
  expect(isRibbonDismissed(state, 'server-saved')).toBe(true);
  expect(markRibbonDismissed(state, 'server-saved').ribbonsDismissed).toEqual(['server-saved']);
});

test('reads and writes onboarding state through storage', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; }
  } as Storage;
  writeOnboardingUiState({ completedAt: '2026-01-01T00:00:00.000Z', ribbonsDismissed: ['a'] }, storage);
  expect(readOnboardingUiState(storage)).toEqual({
    completedAt: '2026-01-01T00:00:00.000Z',
    dismissedAt: undefined,
    replaying: false,
    resetBaseline: undefined,
    ribbonsDismissed: ['a']
  });
});
