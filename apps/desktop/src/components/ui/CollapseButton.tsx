import styles from './card.module.css';

interface CollapseButtonProps {
  collapsed: boolean;
  controls: string;
  /** Complément du verbe : « les validations ». */
  label: string;
  onToggle: () => void;
}

/** Chevron de repli ; dans un `.toggleHead`, il rend tout l'en-tête cliquable. */
export function CollapseButton({ collapsed, controls, label, onToggle }: CollapseButtonProps) {
  return (
    <button
      type="button"
      className={styles.collapse}
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={collapsed ? `Déplier ${label}` : `Replier ${label}`}
      title={collapsed ? 'Déplier' : 'Replier'}
      onClick={onToggle}
    >
      <svg
        className={collapsed ? styles.chevronCollapsed : styles.chevron}
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}
