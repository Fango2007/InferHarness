import { ReactNode } from 'react';

import { useOnboardingContext } from '../onboarding-context.js';
import { SubTab, SubTabBar } from './SubTabBar.js';
import { SetupPill } from './Onboarding.js';

interface MergedPageHeaderProps {
  title: string;
  subtitle: string;
  tabs?: SubTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  action?: ReactNode;
  tabAction?: ReactNode;
}

export function MergedPageHeader({
  title,
  subtitle,
  tabs,
  activeTab,
  onTabChange,
  action,
  tabAction
}: MergedPageHeaderProps) {
  const onboarding = useOnboardingContext();
  const setupPill = onboarding?.status.active ? (
    <SetupPill status={onboarding.status} onDismiss={onboarding.dismissSetup} onOpen={onboarding.replayOnboarding} />
  ) : null;
  return (
    <header className="merged-page-header">
      <div className="merged-page-header__row">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {action || setupPill ? (
          <div className="merged-page-header__action">
            {setupPill}
            {action}
          </div>
        ) : null}
      </div>
      {tabs && activeTab && onTabChange ? (
        <div className="merged-page-header__tabs-row">
          <SubTabBar tabs={tabs} active={activeTab} onChange={onTabChange} />
          {tabAction ? <div className="merged-page-header__tab-action">{tabAction}</div> : null}
        </div>
      ) : null}
    </header>
  );
}
