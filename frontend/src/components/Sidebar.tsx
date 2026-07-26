import { Menu, Settings, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import type { OnboardingStatus } from '../onboarding.js';
import { RegLight } from './RegLight.js';

interface SidebarHealth {
  backend: 'unknown' | 'up' | 'down';
  database: 'unknown' | 'up' | 'down';
  servers: {
    total: number;
    failed: number;
    unavailable: boolean;
  };
}

interface SidebarProps {
  version: string;
  health: SidebarHealth;
  modelCount: number | null;
  templateCount: number | null;
  datasetCount: number | null;
  runCount: number | null;
  onboarding?: OnboardingStatus;
  onSettings: () => void;
}

const navItems = [
  { id: 'catalog', to: '/catalog?tab=servers', section: '/catalog', label: 'Catalog', sub: 'Servers · Models', badge: 'models' },
  { id: 'templates', to: '/templates', section: '/templates', label: 'Templates', sub: '', badge: 'templates' },
  { id: 'datasets', to: '/datasets', section: '/datasets', label: 'Datasets', sub: 'JSONL items', badge: 'datasets' },
  { id: 'run', to: '/run', section: '/run', label: 'Run', sub: '1-8 models' },
  { id: 'results', to: '/results?tab=dashboard', section: '/results', label: 'Results', sub: 'Dash · Board · History', badge: 'runs' },
  { id: 'evaluate', to: '/evaluate', section: '/evaluate', label: 'Evaluate', sub: 'Score queue' }
] as const;

const navOrder = navItems.map((item) => item.id);

function statusLabel(status: 'unknown' | 'up' | 'down') {
  if (status === 'up') {
    return 'Online';
  }
  if (status === 'down') {
    return 'Offline';
  }
  return 'Checking';
}

function serverStatus(health: SidebarHealth['servers']): 'unknown' | 'up' | 'down' {
  if (health.unavailable) {
    return 'down';
  }
  if (health.total === 0) {
    return 'unknown';
  }
  return health.failed > 0 ? 'down' : 'up';
}

function RegLightRow({
  status,
  label,
  detail
}: {
  status: 'unknown' | 'up' | 'down';
  label: string;
  detail?: string;
}) {
  return (
    <div className={`sidebar-health-row sidebar-health-row--${status}`}>
      <RegLight state={status === 'up' ? 'healthy' : status} label={label} compact />
      <span>{label}</span>
      {detail ? <strong>{detail}</strong> : null}
    </div>
  );
}

interface SidebarContentProps extends SidebarProps {
  onNavigate?: () => void;
}

function SidebarContent({
  version,
  health,
  modelCount,
  templateCount,
  datasetCount,
  runCount,
  onboarding,
  onSettings,
  onNavigate
}: SidebarContentProps) {
  const onboardingActive = onboarding?.active === true;
  const unlockedIndex = onboardingActive ? navOrder.indexOf(onboarding.unlockedThrough) : navOrder.length - 1;

  return (
    <>
      <div className="sidebar-brand">
        <strong>InferHarness</strong>
        <span>v{version}</span>
      </div>
      <nav className="sidebar-nav" aria-label="Primary navigation">
        {navItems.map((item, index) => {
          const locked = onboardingActive && index > unlockedIndex;
          const activeSetupItem = onboardingActive && item.id === onboarding.unlockedThrough;
          return (
          <NavLink
            key={item.section}
            to={item.to}
            aria-disabled={locked}
            className={({ isActive }) => [
              'sidebar-item',
              isActive ? 'is-active' : '',
              locked ? 'is-locked' : '',
              activeSetupItem ? 'is-setup-active' : ''
            ].filter(Boolean).join(' ')}
            onClick={(event) => {
              if (locked) {
                event.preventDefault();
                return;
              }
              onNavigate?.();
            }}
          >
            <span className="sidebar-item__main">
              <span>{item.label}</span>
              {'badge' in item && item.badge === 'models' && modelCount !== null ? <b>{modelCount}</b> : null}
              {'badge' in item && item.badge === 'templates' && templateCount !== null ? <b>{templateCount}</b> : null}
              {'badge' in item && item.badge === 'datasets' && datasetCount !== null ? <b>{datasetCount}</b> : null}
              {'badge' in item && item.badge === 'runs' && runCount !== null ? <b>{runCount}</b> : null}
              {locked ? <em aria-hidden="true">lock</em> : null}
            </span>
            {item.sub ? <span className="sidebar-item__sub">{item.sub}</span> : null}
          </NavLink>
          );
        })}
      </nav>
      <div className="sidebar-spacer" />
      {onboardingActive ? (
        <div className="sidebar-setup">
          <div className="sidebar-health__label">Setup</div>
          <div className="sidebar-setup__row">
            <strong>{onboarding.completedSteps}/{onboarding.totalSteps}</strong>
            <span>{onboarding.step === 'welcome' ? 'Start' : onboarding.step.replace('_', ' ')}</span>
          </div>
          <div className="sidebar-setup__track" aria-hidden="true">
            <span style={{ width: `${(onboarding.completedSteps / onboarding.totalSteps) * 100}%` }} />
          </div>
        </div>
      ) : (
        <div className="sidebar-health">
          <div className="sidebar-health__label">Health</div>
          <RegLightRow status={health.backend} label="Backend" detail={statusLabel(health.backend)} />
          <RegLightRow status={health.database} label="Database" detail={statusLabel(health.database)} />
          <RegLightRow
            status={serverStatus(health.servers)}
            label={`${health.servers.total} servers`}
            detail={health.servers.failed > 0 ? `${health.servers.failed} issues` : undefined}
          />
        </div>
      )}
      <div className="sidebar-settings">
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            onSettings();
          }}
        >
          <span aria-hidden="true"><Settings size={15} strokeWidth={1.8} /></span>
          <strong>Settings</strong>
        </button>
      </div>
    </>
  );
}

export function Sidebar(props: SidebarProps) {
  const location = useLocation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const closeDialog = () => {
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  };

  useEffect(() => {
    closeDialog();
  }, [location.pathname, location.search]);

  return (
    <>
      <header className="mobile-app-bar">
        <div>
          <strong>InferHarness</strong>
          <span>v{props.version}</span>
        </div>
        <button
          ref={menuButtonRef}
          type="button"
          className="mobile-app-bar__menu"
          aria-label="Open navigation"
          onClick={() => dialogRef.current?.showModal()}
        >
          <Menu aria-hidden="true" size={22} />
        </button>
      </header>

      <aside className="sidebar sidebar--desktop">
        <SidebarContent {...props} />
      </aside>

      <dialog
        ref={dialogRef}
        className="mobile-nav-dialog"
        aria-label="Primary navigation"
        onCancel={closeDialog}
        onClose={() => menuButtonRef.current?.focus()}
        onClick={(event) => {
          if (event.target === dialogRef.current) {
            closeDialog();
          }
        }}
      >
        <aside className="sidebar sidebar--mobile">
          <button
            type="button"
            className="mobile-nav-dialog__close"
            aria-label="Close navigation"
            onClick={closeDialog}
          >
            <X aria-hidden="true" size={20} />
          </button>
          <SidebarContent {...props} onNavigate={closeDialog} />
        </aside>
      </dialog>
    </>
  );
}
