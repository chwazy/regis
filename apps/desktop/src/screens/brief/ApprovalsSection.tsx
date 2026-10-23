import { useState } from 'react';
import type { Approval } from '@regis/shared';
import { useApprovalsReview } from '../../app/approvals-review';
import { ApprovalRow } from '../../components/ApprovalRow';
import { CollapseButton } from '../../components/ui/CollapseButton';
import card from '../../components/ui/card.module.css';
import styles from './brief.module.css';

interface ApprovalsSectionProps {
  approvals: Approval[];
}

const LIST_ID = 'brief-approvals-list';

export function ApprovalsSection({ approvals }: ApprovalsSectionProps) {
  const { open } = useApprovalsReview();
  // Toujours replié à l'ouverture du Brief, sans mémoriser l'état.
  const [collapsed, setCollapsed] = useState(true);
  const toggle = () => setCollapsed((current) => !current);
  const now = new Date();

  return (
    <section aria-label="À valider" className={`${card.card} ${styles.wide}`}>
      <div className={card.toggleHead}>
        <h2 className={card.title}>À valider</h2>
        <span className={card.count}>{approvals.length}</span>
        <span className={card.aside}>Actions en attente</span>
        <span className={card.right}>
          <CollapseButton
            collapsed={collapsed}
            controls={LIST_ID}
            label="les validations"
            onToggle={toggle}
          />
        </span>
      </div>
      <div id={LIST_ID} data-collapsed={collapsed ? '' : undefined}>
        <div className={styles.approvals}>
          {approvals.length === 0 && <p className={styles.empty}>Aucune validation en attente.</p>}
          {approvals.map((approval) => (
            <ApprovalRow key={approval.id} approval={approval} now={now} onOpen={() => open(approval.id)} />
          ))}
        </div>
      </div>
    </section>
  );
}
