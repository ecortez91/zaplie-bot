import React, {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { getRewardName } from '../apiService';

// Shown until /api/reward-name answers, and whenever it fails or answers with a
// payload we reject. Interpolating the raw nullable value printed the literal
// word "null" in balances and tooltips.
export const DEFAULT_REWARD_NAME = 'sats';

interface RewardNameContextProps {
  /**
   * The configured name, or null while it is loading or after a failure.
   * Only read this where the difference genuinely matters (the admin setting).
   */
  rewardName: string | null;
  /** Always a string: what every other component should render. */
  rewardNameLabel: string;
  setRewardName: React.Dispatch<React.SetStateAction<string | null>>;
  isLoading?: boolean;
  error?: Error | null;
  retry?: () => void;
}

export const RewardNameContext = createContext<RewardNameContextProps>({
  rewardName: null,
  rewardNameLabel: DEFAULT_REWARD_NAME,
  setRewardName: () => {},
  isLoading: true,
  error: null,
  retry: () => {},
});

export const RewardNameProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [rewardName, setRewardName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const loadRewardName = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const data = await getRewardName();
      if (requestId === requestIdRef.current) {
        setRewardName(data.rewardName);
      }
    } catch (loadError) {
      if (requestId === requestIdRef.current) {
        setError(
          loadError instanceof Error
            ? loadError
            : new Error('The reward name could not be loaded.'),
        );
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadRewardName();

    return () => {
      requestIdRef.current += 1;
    };
  }, [loadRewardName]);

  return (
    <RewardNameContext.Provider
      value={{
        rewardName,
        rewardNameLabel: rewardName ?? DEFAULT_REWARD_NAME,
        setRewardName,
        isLoading,
        error,
        retry: loadRewardName,
      }}
    >
      {children}
    </RewardNameContext.Provider>
  );
};
