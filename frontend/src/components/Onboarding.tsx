import { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import type { OnboardingStatus } from '../onboarding.js';

export function SetupPill({
  status,
  onDismiss,
  onOpen
}: {
  status: OnboardingStatus;
  onDismiss?: () => void;
  onOpen?: () => void;
}) {
  if (!status.active) {
    return null;
  }
  return (
    <div className="setup-pill" aria-label={`Setup ${status.completedSteps} of ${status.totalSteps}`}>
      <strong>Setup</strong>
      <span>{status.completedSteps} of {status.totalSteps}</span>
      <span className="setup-pill__dots" aria-hidden="true">
        {Array.from({ length: status.totalSteps }).map((_, index) => (
          <i key={index} className={index < status.completedSteps ? 'is-filled' : ''} />
        ))}
      </span>
      {onOpen ? <button type="button" className="setup-pill__open" onClick={onOpen} aria-label="Open setup checklist">↗</button> : null}
      {onDismiss ? <button type="button" className="setup-pill__dismiss" onClick={onDismiss} aria-label="Dismiss setup">x</button> : null}
    </div>
  );
}

export function ProgressRibbon({
  id,
  step,
  totalSteps,
  doneLabel,
  fact,
  nextLabel,
  onNext,
  onDismiss
}: {
  id: string;
  step: number;
  totalSteps?: number;
  doneLabel: string;
  fact?: string;
  nextLabel: string;
  onNext: () => void;
  onDismiss: (id: string) => void;
}) {
  const stepTotal = totalSteps ?? 3;
  return (
    <div className="onboarding-ribbon" role="status">
      <span className="onboarding-ribbon__check" aria-hidden="true">✓</span>
      <strong>Step {step} of {stepTotal} done</strong>
      <span>{doneLabel}</span>
      {fact ? <code>{fact}</code> : null}
      <span className="onboarding-ribbon__rail" aria-hidden="true">
        {Array.from({ length: stepTotal }).map((_, index) => <i key={index} className={index < step ? 'is-filled' : ''} />)}
      </span>
      <span className="onboarding-ribbon__next">next:</span>
      <button type="button" onClick={onNext}>{nextLabel} →</button>
      <button type="button" className="onboarding-ribbon__dismiss" onClick={() => onDismiss(id)} aria-label="Dismiss onboarding message">x</button>
    </div>
  );
}

export function HandoffToast({
  title,
  body,
  primary,
  secondary,
  onPrimary,
  onSecondary,
  onDismiss
}: {
  title: string;
  body: ReactNode;
  primary: string;
  secondary?: string;
  onPrimary: () => void;
  onSecondary?: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside className="handoff-toast" role="status" aria-live="polite">
      <div className="handoff-toast__bar" />
      <div className="handoff-toast__body">
        <span className="handoff-toast__check" aria-hidden="true">✓</span>
        <div>
          <strong>{title}</strong>
          <p>{body}</p>
          <div className="handoff-toast__actions">
            {secondary ? <button type="button" className="btn btn--ghost btn--sm" onClick={onSecondary}>{secondary}</button> : null}
            <button type="button" className="btn btn--sm" onClick={onPrimary}>{primary} →</button>
          </div>
        </div>
        <button type="button" className="handoff-toast__dismiss" onClick={onDismiss} aria-label="Dismiss handoff">x</button>
      </div>
    </aside>
  );
}

function WelcomeStepCard({
  n,
  title,
  body,
  meta,
  active
}: {
  n: number;
  title: string;
  body: string;
  meta: string;
  active?: boolean;
}) {
  return (
    <article className={active ? 'welcome-step is-active' : 'welcome-step'}>
      <span className="welcome-step__n">{n}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      <code>{meta}</code>
    </article>
  );
}

export function WelcomeCanvas() {
  const navigate = useNavigate();
  return (
    <section className="welcome-canvas">
      <div className="welcome-canvas__hero">
        <div className="welcome-canvas__brand">InferHarness</div>
        <p className="eyebrow">Welcome · first launch</p>
        <h1>Let&apos;s run your first benchmark.</h1>
        <p>
          InferHarness compares LLM inference servers, models, and benchmark templates side by side.
          Built-in templates are ready on first start; three short steps put your first real run on the board.
        </p>
      </div>

      <div className="welcome-steps" aria-label="Onboarding steps">
        <WelcomeStepCard
          n={1}
          title="Connect a server"
          body="Point at an OpenAI-compatible, Ollama, Anthropic, Gemini, or custom endpoint. We probe it on save."
          meta="≈ 30s · model discovery"
          active
        />
        <WelcomeStepCard
          n={2}
          title="Use a model"
          body="Continue with a discovered model from the server you just connected."
          meta="auto · no duplicate setup"
        />
        <WelcomeStepCard
          n={3}
          title="Run your first test"
          body="Use a built-in benchmark template to capture latency, tokens, and result quality from a real run."
          meta="built-in templates ready"
        />
      </div>

      <div className="welcome-canvas__action">
        <div>
          <strong>Ready when you are</strong>
          <p>We will start in Catalog with the add-server drawer. Future sections unlock as real setup data exists.</p>
        </div>
        <button type="button" onClick={() => navigate('/catalog?tab=servers&startOnboarding=1')}>Start step 1 →</button>
      </div>
      <footer>
        <span>Nothing fake is seeded. Onboarding connects real infrastructure and uses shipped benchmark templates.</span>
        <span>first run setup</span>
      </footer>
    </section>
  );
}

export function FirstRunCompleteHero({ onRunAnother }: { onRunAnother: () => void }) {
  return (
    <section className="first-run-hero" aria-live="polite">
      <div className="first-run-hero__icon" aria-hidden="true">★</div>
      <div>
        <p className="eyebrow">Setup complete</p>
        <h2>First run complete · welcome to InferHarness</h2>
        <p>Your first benchmark finished successfully. The setup guide is complete, and future runs can build from the server, model, and built-in templates now available in your library.</p>
      </div>
      <button type="button" onClick={onRunAnother}>Run another test →</button>
    </section>
  );
}
