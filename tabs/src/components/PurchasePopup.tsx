import React, { useContext, useEffect, useId, useRef, useState } from 'react';
import styles from './PurchasePopup.module.css';
import { RewardNameContext } from './RewardNameContext';

interface PurchasePopupProps {
  onClose: () => void;
  hasEnoughSats: boolean;
  reward: Reward;
}

const PurchasePopup: React.FC<PurchasePopupProps> = ({
  onClose,
  hasEnoughSats,
  reward,
}) => {
  const { rewardNameLabel } = useContext(RewardNameContext);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // `aria-modal` is only a promise to assistive tech; it does not move or trap
  // focus, and it does not make Escape work. Without this, focus stayed on the
  // Request button behind the overlay, Tab walked out into the page under the
  // dialog, and there was no keyboard way to dismiss it.
  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    (focusable()[0] ?? dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialog?.contains(active);

      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);
  const storeOwnerEmail =
    process.env.REACT_APP_LNBITS_STORE_OWNER_EMAIL?.trim();

  const requestReward = () => {
    if (!storeOwnerEmail) {
      setError('Reward requests are not configured for this environment.');
      return;
    }

    const subject = encodeURIComponent(`REWARD REQUEST: ${reward.name}`);
    const body = encodeURIComponent(
      `I would like to request ${reward.name} (${reward.price} ${rewardNameLabel}).`,
    );
    window.location.assign(
      `mailto:${storeOwnerEmail}?subject=${subject}&body=${body}`,
    );
    onClose();
  };

  return (
    <div
      className={styles.overlay}
      onClick={event => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className={styles.popup}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className={styles.title}>
          {hasEnoughSats ? 'Request reward' : 'Not enough balance'}
        </h2>
        <p className={styles.message}>
          {hasEnoughSats
            ? 'This sends a request to the rewards administrator. Your balance is not charged by this action.'
            : 'You do not have enough balance to request this reward.'}
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.buttonContainer}>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
          >
            {hasEnoughSats ? 'Cancel' : 'Close'}
          </button>
          {hasEnoughSats && (
            <button
              type="button"
              onClick={requestReward}
              className={styles.buyButton}
            >
              Email request
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PurchasePopup;
