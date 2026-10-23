import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import './WalletInfoCard.css';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';
import {
  duplicateWalletWarning,
  isFunded,
  selectWalletByName,
} from '../services/lnbits/walletSelection';
import { useMsal } from '@azure/msal-react';
import SendPayment from './SendPayment';
import ReceivePayment from './ReceivePayment';
import { RewardNameContext } from './RewardNameContext';

type WalletState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      /** null when the gateway could not read a balance — shown as unavailable. */
      balance: number | null;
      user: User;
      warning: string | null;
    };

const WalletYourWalletInfoCard: React.FC = () => {
  const { instance, accounts } = useMsal();
  // index.tsx sets the active account, so prefer it; accounts[0] is only the
  // fallback for the window between sign-in and the account being activated.
  const aadObjectId = (instance.getActiveAccount() ?? accounts[0])
    ?.localAccountId;
  const [walletState, setWalletState] = useState<WalletState>({
    status: 'loading',
  });
  const [isReceivePopupOpen, setIsReceivePopupOpen] = useState(false);
  const [isSendPopupOpen, setIsSendPopupOpen] = useState(false);
  const requestIdRef = useRef(0);
  const { rewardNameLabel } = useContext(RewardNameContext);

  const loadWallet = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setWalletState({ status: 'loading' });
    setIsReceivePopupOpen(false);
    setIsSendPopupOpen(false);

    if (!aadObjectId) {
      setWalletState({
        status: 'error',
        message: 'Sign in to load your wallet.',
      });
      return;
    }

    try {
      const users = await getUsers({ aadObjectId });
      const matchingUsers = users.filter(
        user => user.aadObjectId === aadObjectId,
      );

      if (requestId !== requestIdRef.current) return;
      if (matchingUsers.length !== 1) {
        setWalletState({
          status: 'error',
          message: "We couldn't match your signed-in account to a wallet.",
        });
        return;
      }

      const user = matchingUsers[0];
      const wallets = await getUserWallets(user.id);
      if (requestId !== requestIdRef.current) return;

      const match = selectWalletByName(wallets, user.id, 'private');

      // A wallet under this name that belongs to somebody else is the one case
      // where there is nothing safe to show: refuse it outright.
      if (match.foreignMatch) {
        setWalletState({
          status: 'error',
          message: "We couldn't confirm your Private wallet belongs to you.",
        });
        return;
      }

      if (!match.wallet) {
        setWalletState({
          status: 'error',
          message: "We couldn't find your Private wallet.",
        });
        return;
      }

      const privateWallet = match.wallet;

      setWalletState({
        status: 'ready',
        // A balance the gateway could not read renders as unavailable rather
        // than a fabricated zero; receiving and sending still work, because
        // neither depends on this number.
        balance: isFunded(privateWallet)
          ? privateWallet.balance_msat / 1000
          : null,
        user: { ...user, privateWallet },
        warning:
          match.matchCount > 1
            ? duplicateWalletWarning(privateWallet, match.matchCount)
            : null,
      });
    } catch {
      if (requestId === requestIdRef.current) {
        setWalletState({
          status: 'error',
          message: "We couldn't load your wallet. Try again.",
        });
      }
    }
  }, [aadObjectId]);

  useEffect(() => {
    void loadWallet();

    return () => {
      requestIdRef.current += 1;
    };
  }, [loadWallet]);

  const walletReady = walletState.status === 'ready';
  const currentUser = walletReady ? walletState.user : null;

  return (
    <div className="wallet-info">
      <h4>Your wallet</h4>
      <p>Amount received from other users:</p>

      <div
        className="horizontal-container"
        aria-busy={walletState.status === 'loading'}
      >
        {walletState.status === 'loading' ? (
          <p className="wallet-loading" role="status">
            Loading wallet...
          </p>
        ) : walletState.status === 'error' ? (
          <div className="wallet-error-state">
            <p role="alert">{walletState.message}</p>
            <button
              type="button"
              className="wallet-retry-btn"
              onClick={loadWallet}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="item">
              {walletState.balance === null ? (
                <p className="wallet-balance-unavailable">
                  Balance unavailable
                </p>
              ) : (
                <h1>{walletState.balance.toLocaleString()}</h1>
              )}
            </div>
            {walletState.balance !== null && (
              <div className="item">{rewardNameLabel}</div>
            )}
          </>
        )}
      </div>

      {walletReady && walletState.warning ? (
        <p className="wallet-warning" role="status">
          {walletState.warning}
        </p>
      ) : null}

      <div className="wallet-buttons">
        <button
          type="button"
          onClick={() => setIsReceivePopupOpen(true)}
          className="receive-btn"
          disabled={!walletReady}
        >
          Receive
        </button>
        <button
          type="button"
          onClick={() => setIsSendPopupOpen(true)}
          className="send-btn"
          disabled={!walletReady}
        >
          Send
        </button>

        {isReceivePopupOpen && currentUser ? (
          <div className="overlay" onClick={() => setIsReceivePopupOpen(false)}>
            <div className="popup" onClick={event => event.stopPropagation()}>
              <ReceivePayment
                onClose={() => setIsReceivePopupOpen(false)}
                currentUserLNbitDetails={currentUser}
              />
            </div>
          </div>
        ) : null}

        {isSendPopupOpen && currentUser ? (
          <div className="overlay" onClick={() => setIsSendPopupOpen(false)}>
            <div className="popup" onClick={event => event.stopPropagation()}>
              <SendPayment
                onClose={() => setIsSendPopupOpen(false)}
                currentUserLNbitDetails={currentUser}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default WalletYourWalletInfoCard;
